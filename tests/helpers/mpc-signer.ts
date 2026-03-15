import { contracts, constants, chainAdapters } from "signet.js";
import { PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { computeInnerHash, type IndexedInnerInstruction } from "./evm-signer";

const { ChainSignatureContract } = contracts.evm;
const { abi: chainSigAbi } = contracts.evm.utils.ChainSignaturesContractABI;
const { EVM } = chainAdapters.evm;

type MpcContract = InstanceType<typeof ChainSignatureContract>;

export interface MpcSigner {
  contract: MpcContract;
  evm: InstanceType<typeof EVM>;
  predecessor: string;
  publicClient: ReturnType<typeof createPublicClient>;
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
    publicClient,
    walletClient,
    contractAddress: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET as `0x${string}`,
  });
  const evm = new EVM({ publicClient, contract });

  return { contract, evm, predecessor: account.address, publicClient };
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
): Promise<{
  signature: Buffer;
  recoveryId: number;
  sepoliaRequestTxHash: string;
  sepoliaRespondTxHash: string;
}> {
  const innerHash = computeInnerHash(programId, nonce, remainingAccountKeys, indexedInstructions);
  const { hashToSign } = await signer.evm.prepareMessageForSigning({ raw: innerHash });

  const signArgs = { payload: hashToSign, path, key_version: 1 };
  const { txHash, requestId } = await signer.contract.createSignatureRequest(signArgs);
  const receipt = await signer.publicClient.waitForTransactionReceipt({ hash: txHash });

  const pollResult = await signer.contract.pollForRequestId({
    requestId,
    payload: signArgs.payload,
    path: signArgs.path,
    keyVersion: signArgs.key_version,
    fromBlock: receipt.blockNumber,
    options: { delay: 5_000, retryCount: 12 },
  });

  if (!pollResult || "error" in pollResult) {
    throw new Error(
      `MPC signature failed: ${pollResult ? JSON.stringify(pollResult) : "not found"}`
    );
  }

  const respondLogs = await signer.publicClient.getContractEvents({
    address: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET as Hex,
    abi: chainSigAbi,
    eventName: "SignatureResponded",
    args: { requestId },
    fromBlock: receipt.blockNumber,
    toBlock: "latest",
  });
  const respondTxHash = respondLogs.at(-1)?.transactionHash;
  if (!respondTxHash) {
    throw new Error("SignatureResponded event not found after successful poll");
  }

  return {
    signature: Buffer.concat([Buffer.from(pollResult.r, "hex"), Buffer.from(pollResult.s, "hex")]),
    recoveryId: pollResult.v - 27,
    sepoliaRequestTxHash: txHash,
    sepoliaRespondTxHash: respondTxHash,
  };
}

export async function signMessageMpcSimple(
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
