import { contracts, constants, chainAdapters } from "signet.js";
import { PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { computeInnerHash, type IndexedInnerInstruction } from "./evm-signer";

const { ChainSignatureContract } = contracts.evm;
const { EVM } = chainAdapters.evm;

type MpcContract = InstanceType<typeof ChainSignatureContract>;

export interface MpcSigner {
  contract: MpcContract;
  evm: InstanceType<typeof EVM>;
  predecessor: string;
}

export function createMpcSigner(sepoliaPrivateKey: string, sepoliaRpcUrl: string): MpcSigner {
  const account = privateKeyToAccount(sepoliaPrivateKey as `0x${string}`);
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(sepoliaRpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(sepoliaRpcUrl),
  });
  const contract = new ChainSignatureContract({
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    contractAddress: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET as `0x${string}`,
  });
  const evm = new EVM({ publicClient: publicClient as any, contract });

  return { contract, evm, predecessor: account.address };
}

export async function deriveMpcEthAddress(
  signer: MpcSigner,
  path: string,
  keyVersion: number
): Promise<Buffer> {
  const { address } = await signer.evm.deriveAddressAndPublicKey(
    signer.predecessor,
    path,
    keyVersion
  );
  return Buffer.from(hexToBytes(address as `0x${string}`));
}

export async function signMessageMpc(
  signer: MpcSigner,
  programId: PublicKey,
  nonce: bigint,
  remainingAccountKeys: PublicKey[],
  indexedInstructions: IndexedInnerInstruction[],
  path: string
): Promise<{ signature: Buffer; recoveryId: number }> {
  const innerHash = computeInnerHash(programId, nonce, remainingAccountKeys, indexedInstructions);
  const { hashToSign } = await signer.evm.prepareMessageForSigning({ raw: innerHash });

  const rsv = await signer.contract.sign(
    { payload: hashToSign, path, key_version: 1 },
    { sign: {}, retry: { delay: 5_000, retryCount: 12 } }
  );

  return {
    signature: Buffer.concat([Buffer.from(rsv.r, "hex"), Buffer.from(rsv.s, "hex")]),
    recoveryId: rsv.v - 27,
  };
}
