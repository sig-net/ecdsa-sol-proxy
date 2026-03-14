import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EcdsaProxy } from "../target/types/ecdsa_proxy";
import { expect } from "chai";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  deriveWalletPDA,
  ethAddressFromAccount,
  signMessage,
  makeHighS,
  toAnchorInnerInstructions,
  toIndexedInnerInstructions,
  buildRemainingAccounts,
} from "./helpers/evm-signer";

describe("ecdsa-proxy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ecdsaProxy as Program<EcdsaProxy>;
  const programId = program.programId;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const evmWallet = privateKeyToAccount(generatePrivateKey());
  const evmWallet2 = privateKeyToAccount(generatePrivateKey());

  const ethAddress = ethAddressFromAccount(evmWallet);
  const ethAddress2 = ethAddressFromAccount(evmWallet2);

  let walletPDA: PublicKey;
  let walletBump: number;
  let wallet2PDA: PublicKey;

  let mint: PublicKey;
  let pdaTokenAccount: PublicKey;

  async function getNonce(pda: PublicKey): Promise<bigint> {
    const state = await program.account.walletState.fetch(pda);
    return BigInt(state.nonce.toString());
  }

  async function createATA(owner: PublicKey): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      owner,
      true // allowOwnerOffCurve — needed for PDAs
    );
    return ata.address;
  }

  /** Helper: sign + build indexed instructions from pubkey-based ones */
  async function signAndIndex(
    wallet: Parameters<typeof signMessage>[0],
    innerIxs: TransactionInstruction[],
    remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
    nonce: bigint
  ) {
    const remainingKeys = remaining.map((r) => r.pubkey);
    const indexed = toIndexedInnerInstructions(innerIxs, remainingKeys);
    const { signature, recoveryId } = await signMessage(
      wallet,
      programId,
      nonce,
      remainingKeys,
      indexed
    );
    return { signature, recoveryId, indexed };
  }

  before(async () => {
    [walletPDA, walletBump] = deriveWalletPDA(ethAddress, programId);
    [wallet2PDA] = deriveWalletPDA(ethAddress2, programId);

    mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
  });

  it("1. Initialize wallet — PDA created, correct state", async () => {
    await program.methods
      .initializeWallet(Array.from(ethAddress))
      .accounts({ payer: payer.publicKey })
      .rpc();

    const state = await program.account.walletState.fetch(walletPDA);
    expect(Buffer.from(state.ethAddress)).to.deep.equal(ethAddress);
    expect(state.nonce.toNumber()).to.equal(0);
    expect(state.bump).to.equal(walletBump);
  });

  it("2. Execute SPL token transfer — PDA signs as authority, tokens move, nonce increments", async () => {
    pdaTokenAccount = await createATA(walletPDA);

    await mintTo(provider.connection, payer, mint, pdaTokenAccount, payer, 1_000_000);

    const recipientTA = await createATA(Keypair.generate().publicKey);
    const transferAmount = 100_000n;
    const innerIx = createTransferInstruction(
      pdaTokenAccount,
      recipientTA,
      walletPDA,
      transferAmount
    );

    const remaining = buildRemainingAccounts([innerIx]);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId, indexed } = await signAndIndex(
      evmWallet,
      [innerIx],
      remaining,
      nonce
    );

    await program.methods
      .execute(
        Array.from(signature),
        recoveryId,
        new anchor.BN(nonce.toString()),
        toAnchorInnerInstructions(indexed)
      )
      .accounts({
        walletState: walletPDA,
        payer: payer.publicKey,
      })
      .remainingAccounts(remaining)
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientTA);
    expect(Number(recipientAccount.amount)).to.equal(Number(transferAmount));

    const state = await program.account.walletState.fetch(walletPDA);
    expect(state.nonce.toNumber()).to.equal(1);
  });

  it("3. Replay protection — same signed message fails after execution", async () => {
    const recipientTA = await createATA(Keypair.generate().publicKey);
    const innerIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 10_000n);

    const remaining = buildRemainingAccounts([innerIx]);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId, indexed } = await signAndIndex(
      evmWallet,
      [innerIx],
      remaining,
      nonce
    );

    const accounts = { walletState: walletPDA, payer: payer.publicKey };

    await program.methods
      .execute(
        Array.from(signature),
        recoveryId,
        new anchor.BN(nonce.toString()),
        toAnchorInnerInstructions(indexed)
      )
      .accounts(accounts)
      .remainingAccounts(remaining)
      .rpc();

    try {
      await program.methods
        .execute(
          Array.from(signature),
          recoveryId,
          new anchor.BN(nonce.toString()),
          toAnchorInnerInstructions(indexed)
        )
        .accounts(accounts)
        .remainingAccounts(remaining)
        .rpc();
      expect.fail("Should have thrown NonceMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("NonceMismatch");
    }
  });

  it("4. Wrong signer — different EVM wallet fails (AddressMismatch)", async () => {
    const recipientTA = await createATA(Keypair.generate().publicKey);
    const innerIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 10_000n);

    const remaining = buildRemainingAccounts([innerIx]);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId, indexed } = await signAndIndex(
      evmWallet2, // wrong signer
      [innerIx],
      remaining,
      nonce
    );

    try {
      await program.methods
        .execute(
          Array.from(signature),
          recoveryId,
          new anchor.BN(nonce.toString()),
          toAnchorInnerInstructions(indexed)
        )
        .accounts({
          walletState: walletPDA,
          payer: payer.publicKey,
        })
        .remainingAccounts(remaining)
        .rpc();
      expect.fail("Should have thrown AddressMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("AddressMismatch");
    }
  });

  it("5. Nonce mismatch — wrong nonce value fails", async () => {
    const recipientTA = await createATA(Keypair.generate().publicKey);
    const innerIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 10_000n);

    const remaining = buildRemainingAccounts([innerIx]);
    const wrongNonce = 999n;
    const { signature, recoveryId, indexed } = await signAndIndex(
      evmWallet,
      [innerIx],
      remaining,
      wrongNonce
    );

    try {
      await program.methods
        .execute(
          Array.from(signature),
          recoveryId,
          new anchor.BN(wrongNonce.toString()),
          toAnchorInnerInstructions(indexed)
        )
        .accounts({
          walletState: walletPDA,
          payer: payer.publicKey,
        })
        .remainingAccounts(remaining)
        .rpc();
      expect.fail("Should have thrown NonceMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("NonceMismatch");
    }
  });

  it("6. Wrong chain_id — different chain_id produces AddressMismatch", async () => {
    const recipientTA = await createATA(Keypair.generate().publicKey);
    const innerIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 10_000n);

    const remaining = buildRemainingAccounts([innerIx]);
    const remainingKeys = remaining.map((r) => r.pubkey);
    const indexed = toIndexedInnerInstructions([innerIx], remainingKeys);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId } = await signMessage(
      evmWallet,
      programId,
      nonce,
      remainingKeys,
      indexed,
      42n // wrong chain_id — signed with 42 but program uses hardcoded devnet (2)
    );

    try {
      await program.methods
        .execute(
          Array.from(signature),
          recoveryId,
          new anchor.BN(nonce.toString()),
          toAnchorInnerInstructions(indexed)
        )
        .accounts({
          walletState: walletPDA,
          payer: payer.publicKey,
        })
        .remainingAccounts(remaining)
        .rpc();
      expect.fail("Should have thrown AddressMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("AddressMismatch");
    }
  });

  it("7. Signature malleability — high-S signature rejected", async () => {
    const recipientTA = await createATA(Keypair.generate().publicKey);
    const innerIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 10_000n);

    const remaining = buildRemainingAccounts([innerIx]);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId, indexed } = await signAndIndex(
      evmWallet,
      [innerIx],
      remaining,
      nonce
    );

    const malleableSig = makeHighS(signature);

    try {
      await program.methods
        .execute(
          Array.from(malleableSig),
          recoveryId,
          new anchor.BN(nonce.toString()),
          toAnchorInnerInstructions(indexed)
        )
        .accounts({
          walletState: walletPDA,
          payer: payer.publicKey,
        })
        .remainingAccounts(remaining)
        .rpc();
      expect.fail("Should have thrown SignatureMalleability");
    } catch (err: unknown) {
      expect(String(err)).to.include("SignatureMalleability");
    }
  });

  it("8. Multiple inner instructions — 2 token transfers, nonce increments once", async () => {
    const recipientTA1 = await createATA(Keypair.generate().publicKey);
    const recipientTA2 = await createATA(Keypair.generate().publicKey);

    const innerIx1 = createTransferInstruction(pdaTokenAccount, recipientTA1, walletPDA, 20_000n);
    const innerIx2 = createTransferInstruction(pdaTokenAccount, recipientTA2, walletPDA, 30_000n);

    const remaining = buildRemainingAccounts([innerIx1, innerIx2]);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId, indexed } = await signAndIndex(
      evmWallet,
      [innerIx1, innerIx2],
      remaining,
      nonce
    );

    await program.methods
      .execute(
        Array.from(signature),
        recoveryId,
        new anchor.BN(nonce.toString()),
        toAnchorInnerInstructions(indexed)
      )
      .accounts({
        walletState: walletPDA,
        payer: payer.publicKey,
      })
      .remainingAccounts(remaining)
      .rpc();

    const account1 = await getAccount(provider.connection, recipientTA1);
    const account2 = await getAccount(provider.connection, recipientTA2);
    expect(Number(account1.amount)).to.equal(20_000);
    expect(Number(account2.amount)).to.equal(30_000);
    expect(Number(await getNonce(walletPDA))).to.equal(Number(nonce) + 1);
  });

  it("9. Tampered instruction data — modified inner ix after signing fails", async () => {
    const recipientTA = await createATA(Keypair.generate().publicKey);

    const innerIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 10_000n);

    const remaining = buildRemainingAccounts([innerIx]);
    const nonce = await getNonce(walletPDA);
    const { signature, recoveryId } = await signAndIndex(evmWallet, [innerIx], remaining, nonce);

    // Tamper: different amount
    const tamperedIx = createTransferInstruction(pdaTokenAccount, recipientTA, walletPDA, 999_999n);
    const tamperedIndexed = toIndexedInnerInstructions(
      [tamperedIx],
      remaining.map((r) => r.pubkey)
    );

    try {
      await program.methods
        .execute(
          Array.from(signature),
          recoveryId,
          new anchor.BN(nonce.toString()),
          toAnchorInnerInstructions(tamperedIndexed)
        )
        .accounts({
          walletState: walletPDA,
          payer: payer.publicKey,
        })
        .remainingAccounts(remaining)
        .rpc();
      expect.fail("Should have thrown AddressMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("AddressMismatch");
    }
  });

  it("10. Close wallet — PDA closed, rent returned", async () => {
    const rentRecipient = Keypair.generate();
    const nonce = await getNonce(walletPDA);

    // close uses empty remaining accounts and empty instructions
    const { signature, recoveryId } = await signMessage(evmWallet, programId, nonce, [], []);

    const recipientBalanceBefore = await provider.connection.getBalance(rentRecipient.publicKey);

    await program.methods
      .closeWallet(Array.from(signature), recoveryId, new anchor.BN(nonce.toString()))
      .accounts({
        walletState: walletPDA,
        payer: payer.publicKey,
        rentRecipient: rentRecipient.publicKey,
      })
      .rpc();

    const accountInfo = await provider.connection.getAccountInfo(walletPDA);
    expect(accountInfo).to.equal(null);

    const recipientBalanceAfter = await provider.connection.getBalance(rentRecipient.publicKey);
    expect(recipientBalanceAfter).to.be.greaterThan(recipientBalanceBefore);
  });

  it("11. Close wrong signer — different EVM wallet cannot close", async () => {
    await program.methods
      .initializeWallet(Array.from(ethAddress2))
      .accounts({ payer: payer.publicKey })
      .rpc();

    // Try closing wallet2 with evmWallet (wrong — wallet2 belongs to evmWallet2)
    const { signature, recoveryId } = await signMessage(evmWallet, programId, 0n, [], []);

    try {
      await program.methods
        .closeWallet(Array.from(signature), recoveryId, new anchor.BN(0))
        .accounts({
          walletState: wallet2PDA,
          payer: payer.publicKey,
          rentRecipient: payer.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown AddressMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("AddressMismatch");
    }
  });
});
