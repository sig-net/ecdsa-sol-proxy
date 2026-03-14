import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { EcdsaProxy } from "../target/types/ecdsa_proxy";
import { expect } from "chai";
import { Connection, Keypair } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  deriveWalletPDA,
  toAnchorInnerInstructions,
  toIndexedInnerInstructions,
  buildRemainingAccounts,
} from "./helpers/evm-signer";
import { createMpcSigner, deriveMpcEthAddress, signMessageMpc } from "./helpers/mpc-signer";

const SKIP = !process.env.SEPOLIA_PRIVATE_KEY;

(SKIP ? describe.skip : describe)("mpc-ecdsa-proxy", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<EcdsaProxy>;
  let payer: Keypair;

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
  });

  it("e2e: MPC-signed SPL token transfer via ecdsa-proxy", async () => {
    const programId = program.programId;
    const signer = createMpcSigner(process.env.SEPOLIA_PRIVATE_KEY!, process.env.SEPOLIA_RPC_URL!);

    // Derive ETH address from MPC and initialize wallet PDA
    const ethAddress = await deriveMpcEthAddress(signer, MPC_PATH, 1);
    const [walletPDA] = deriveWalletPDA(ethAddress, programId);

    await program.methods
      .initializeWallet(Array.from(ethAddress))
      .accounts({ payer: payer.publicKey })
      .rpc();

    // Mint tokens to PDA
    const mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const pdaAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      walletPDA,
      true
    );
    await mintTo(provider.connection, payer, mint, pdaAta.address, payer, 1_000_000);

    // Build transfer instruction
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

    // Sign via MPC and execute
    const remaining = buildRemainingAccounts([innerIx]);
    const remainingKeys = remaining.map((r) => r.pubkey);
    const indexed = toIndexedInnerInstructions([innerIx], remainingKeys);
    const nonce = 0n;

    const { signature, recoveryId } = await signMessageMpc(
      signer,
      programId,
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

    // Verify tokens moved
    const recipientAccount = await getAccount(provider.connection, recipientAta.address);
    expect(Number(recipientAccount.amount)).to.equal(Number(transferAmount));
  });
});
