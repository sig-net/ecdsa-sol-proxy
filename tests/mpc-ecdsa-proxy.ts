import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { EcdsaProxy } from "../target/types/ecdsa_proxy";
import { expect } from "chai";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  type Account,
  createAssociatedTokenAccountInstruction,
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  deriveWalletPDA,
  toAnchorInnerInstructions,
  toIndexedInnerInstructions,
  buildRemainingAccounts,
} from "./helpers/evm-signer";
import {
  type MpcSigner,
  createMpcSigner,
  deriveMpcEthAddress,
  signMessageMpc,
  signMessageMpcSimple,
} from "./helpers/mpc-signer";

describe("mpc-ecdsa-proxy", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<EcdsaProxy>;
  let payer: Keypair;
  let walletPDA: PublicKey;
  let mint: PublicKey;
  let pdaAta: Account;
  let signer: MpcSigner;
  let ethAddress: Buffer;

  const MPC_PATH = `ecdsa-sol-proxy,${Date.now()}`;

  before(async () => {
    const connection = new Connection(process.env.SOLANA_DEVNET_RPC_URL!, "confirmed");
    const walletKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.SOLANA_DEVNET_PRIVATE_KEY!))
    );
    payer = walletKeypair;
    const wallet = new anchor.Wallet(walletKeypair);
    provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    program = anchor.workspace.ecdsaProxy as Program<EcdsaProxy>;
    signer = createMpcSigner(process.env.SEPOLIA_PRIVATE_KEY!, process.env.SEPOLIA_RPC_URL!);
    ethAddress = await deriveMpcEthAddress(signer, MPC_PATH, 1);
    [walletPDA] = deriveWalletPDA(ethAddress, program.programId);

    const initTxHash = await program.methods
      .initializeWallet(Array.from(ethAddress))
      .accounts({ payer: payer.publicKey })
      .rpc();
    console.log("Solana initializeWallet tx:", initTxHash);

    mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    pdaAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      walletPDA,
      true
    );
    await mintTo(provider.connection, payer, mint, pdaAta.address, payer, 2_000_000);
  });

  it("e2e: MPC-signed SPL token transfer via ecdsa-proxy", async () => {
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      Keypair.generate().publicKey,
      true
    );
    const transferAmount = 100_000n;
    const innerIx = createTransferInstruction(
      pdaAta.address,
      recipientAta.address,
      walletPDA,
      transferAmount
    );

    const remaining = buildRemainingAccounts([innerIx]);
    const remainingKeys = remaining.map((r) => r.pubkey);
    const indexed = toIndexedInnerInstructions([innerIx], remainingKeys);
    const nonce = 0n;

    const { signature, recoveryId, sepoliaRequestTxHash, sepoliaRespondTxHash } =
      await signMessageMpc(signer, program.programId, nonce, remainingKeys, indexed, MPC_PATH);
    console.log("Sepolia MPC request tx:", sepoliaRequestTxHash);
    console.log("Sepolia MPC respond tx:", sepoliaRespondTxHash);

    const executeTxHash = await program.methods
      .execute(
        Array.from(signature),
        recoveryId,
        new anchor.BN(nonce.toString()),
        toAnchorInnerInstructions(indexed)
      )
      .accounts({ walletState: walletPDA, payer: payer.publicKey })
      .remainingAccounts(remaining)
      .rpc();
    console.log("Solana execute tx:", executeTxHash);

    const recipientAccount = await getAccount(provider.connection, recipientAta.address);
    expect(Number(recipientAccount.amount)).to.equal(Number(transferAmount));
  });

  it("e2e: ATA creation + token transfer via contract.sign (CPI depth 2)", async () => {
    // Create a separate mint so this test is self-contained
    const mintC = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const pdaAtaC = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mintC,
      walletPDA,
      true
    );
    await mintTo(provider.connection, payer, mintC, pdaAtaC.address, payer, 500_000);

    // Compute the recipient's ATA address (account does NOT exist yet)
    const recipient = Keypair.generate().publicKey;
    const recipientAta = getAssociatedTokenAddressSync(mintC, recipient, true);

    const transferAmount = 100_000n;
    const innerIxs = [
      // 1. Create ATA via ATA program — CPI depth 2 (ATA program → System + Token programs)
      //    Payer (test wallet) funds it; signer status propagates from outer tx
      createAssociatedTokenAccountInstruction(payer.publicKey, recipientAta, recipient, mintC),
      // 2. Transfer tokens to the just-created ATA — PDA signs via invoke_signed
      createTransferInstruction(pdaAtaC.address, recipientAta, walletPDA, transferAmount),
    ];

    const remaining = buildRemainingAccounts(innerIxs);
    const remainingKeys = remaining.map((r) => r.pubkey);
    const indexed = toIndexedInnerInstructions(innerIxs, remainingKeys);

    const walletState = await program.account.walletState.fetch(walletPDA);
    const nonce = BigInt(walletState.nonce.toString());

    const { signature, recoveryId } = await signMessageMpcSimple(
      signer,
      program.programId,
      nonce,
      remainingKeys,
      indexed,
      MPC_PATH
    );

    await program.methods
      .execute(
        Array.from(signature),
        recoveryId,
        new anchor.BN(nonce.toString()),
        toAnchorInnerInstructions(indexed)
      )
      .accounts({ walletState: walletPDA, payer: payer.publicKey })
      .remainingAccounts(remaining)
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    expect(Number(recipientAccount.amount)).to.equal(Number(transferAmount));
  });
});
