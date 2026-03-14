import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { hexToBytes, keccak256, parseSignature } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import idl from "../../target/idl/ecdsa_proxy.json";

const coder = new BorshCoder(idl as Idl);

/** Index-based version sent on-chain (flags: bit 0 = isSigner, bit 1 = isWritable) */
export interface IndexedInnerAccountMeta {
  accountIndex: number;
  isSigner: boolean;
  isWritable: boolean;
}

function packFlags(isSigner: boolean, isWritable: boolean): number {
  return (isSigner ? 0x01 : 0) | (isWritable ? 0x02 : 0);
}

export interface IndexedInnerInstruction {
  programIdIndex: number;
  accounts: IndexedInnerAccountMeta[];
  data: Buffer;
}

/** Must match the hardcoded CHAIN_ID in constants.rs (devnet = 2) */
export const CHAIN_ID = 2n;

const WALLET_SEED = Buffer.from("ecdsa_proxy");
const WALLET_PREFIX = Buffer.from("wallet");

const SECP256K1_ORDER = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

export function deriveWalletPDA(ethAddress: Buffer, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([WALLET_SEED, WALLET_PREFIX, ethAddress], programId);
}

export function ethAddressFromAccount(account: PrivateKeyAccount): Buffer {
  return Buffer.from(hexToBytes(account.address));
}

/**
 * Convert pubkey-based InnerInstructions to index-based, given a remaining_accounts list.
 * Returns the indexed instructions that match the indices in remainingAccounts.
 */
export function toIndexedInnerInstructions(
  innerInstructions: TransactionInstruction[],
  remainingAccounts: PublicKey[]
): IndexedInnerInstruction[] {
  const keyToIndex = new Map<string, number>();
  remainingAccounts.forEach((key, i) => keyToIndex.set(key.toBase58(), i));

  return innerInstructions.map((ix) => {
    const programIdIndex = keyToIndex.get(ix.programId.toBase58());
    if (programIdIndex === undefined) {
      throw new Error(`Program ID ${ix.programId.toBase58()} not found in remainingAccounts`);
    }
    return {
      programIdIndex,
      accounts: ix.keys.map((a) => {
        const accountIndex = keyToIndex.get(a.pubkey.toBase58());
        if (accountIndex === undefined) {
          throw new Error(`Account ${a.pubkey.toBase58()} not found in remainingAccounts`);
        }
        return {
          accountIndex,
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        };
      }),
      data: Buffer.from(ix.data),
    };
  });
}

export function computeInnerHash(
  programId: PublicKey,
  nonce: bigint,
  remainingAccountKeys: PublicKey[],
  indexedInstructions: IndexedInnerInstruction[],
  chainIdOverride?: bigint
): Buffer {
  const instructionsData = Buffer.concat(
    indexedInstructions.map((ix) =>
      coder.types.encode("InnerInstruction", {
        program_id_index: ix.programIdIndex,
        accounts: ix.accounts.map((a) => ({
          account_index: a.accountIndex,
          flags: packFlags(a.isSigner, a.isWritable),
        })),
        data: ix.data,
      })
    )
  );
  const instructionsHash = Buffer.from(keccak256(instructionsData, "bytes"));

  // Hash remaining account keys: keccak256(key0 || key1 || ... || keyN)
  const accountsData = Buffer.concat(remainingAccountKeys.map((k) => k.toBuffer()));
  const accountsHash = Buffer.from(keccak256(accountsData, "bytes"));

  // chain_id(8) || program_id(32) || nonce(8) || accounts_hash(32) || instructions_hash(32) = 112
  const innerData = Buffer.alloc(8 + 32 + 8 + 32 + 32);
  innerData.writeBigUInt64LE(chainIdOverride ?? CHAIN_ID, 0);
  programId.toBuffer().copy(innerData, 8);
  innerData.writeBigUInt64LE(nonce, 40);
  accountsHash.copy(innerData, 48);
  instructionsHash.copy(innerData, 80);

  return Buffer.from(keccak256(innerData, "bytes"));
}

export async function signMessage(
  account: PrivateKeyAccount,
  programId: PublicKey,
  nonce: bigint,
  remainingAccountKeys: PublicKey[],
  indexedInstructions: IndexedInnerInstruction[],
  chainIdOverride?: bigint
): Promise<{ signature: Buffer; recoveryId: number }> {
  const innerHash = computeInnerHash(
    programId,
    nonce,
    remainingAccountKeys,
    indexedInstructions,
    chainIdOverride
  );
  const sig = parseSignature(await account.signMessage({ message: { raw: innerHash } }));
  const r = Buffer.from(hexToBytes(sig.r));
  const s = Buffer.from(hexToBytes(sig.s));

  return { signature: Buffer.concat([r, s]), recoveryId: sig.yParity };
}

export function makeHighS(signature: Buffer): Buffer {
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);

  const sBigInt = BigInt("0x" + s.toString("hex"));
  const highS = SECP256K1_ORDER - sBigInt;
  const highSHex = highS.toString(16).padStart(64, "0");

  return Buffer.concat([r, Buffer.from(highSHex, "hex")]);
}

export function toAnchorInnerInstructions(indexedInstructions: IndexedInnerInstruction[]) {
  return indexedInstructions.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accounts: ix.accounts.map((a) => ({
      accountIndex: a.accountIndex,
      flags: packFlags(a.isSigner, a.isWritable),
    })),
    data: ix.data,
  }));
}

/**
 * Build a remainingAccounts list from pubkey-based InnerInstructions,
 * deduplicating keys while preserving order.
 */
export function buildRemainingAccounts(
  innerInstructions: TransactionInstruction[]
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const seen = new Map<string, { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>();

  for (const ix of innerInstructions) {
    for (const acct of ix.keys) {
      const key = acct.pubkey.toBase58();
      const existing = seen.get(key);
      if (existing) {
        // Merge: isWritable is true if any usage is writable
        existing.isWritable = existing.isWritable || acct.isWritable;
      } else {
        seen.set(key, {
          pubkey: acct.pubkey,
          isSigner: false, // PDA signs via invoke_signed, not at tx level
          isWritable: acct.isWritable,
        });
      }
    }
    // Add program ID
    const progKey = ix.programId.toBase58();
    if (!seen.has(progKey)) {
      seen.set(progKey, {
        pubkey: ix.programId,
        isSigner: false,
        isWritable: false,
      });
    }
  }

  return Array.from(seen.values());
}
