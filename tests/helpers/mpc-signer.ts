import { contracts, constants, chainAdapters } from "signet.js";
import { PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { computeInnerHash, type IndexedInnerInstruction } from "./evm-signer";

const { ChainSignatureContract } = contracts.evm;
const { abi: chainSigAbi } = contracts.evm.utils.ChainSignaturesContractABI;
const { EVM } = chainAdapters.evm;

type MpcContract = InstanceType<typeof ChainSignatureContract>;
type EvmAdapter = InstanceType<typeof EVM>;
type SepoliaPublicClient = ReturnType<typeof createPublicClient>;

export function createMpcSigner(sepoliaPrivateKey: string, sepoliaRpcUrl: string) {
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
  const evmAdapter = new EVM({ publicClient, contract });

  return { contract, evmAdapter, predecessor: account.address, publicClient };
}

export async function signMessageMpc(
  contract: MpcContract,
  evmAdapter: EvmAdapter,
  publicClient: SepoliaPublicClient,
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
  const { hashToSign } = await evmAdapter.prepareMessageForSigning({ raw: innerHash });

  const signArgs = { payload: hashToSign, path, key_version: 1 };
  const { txHash, requestId } = await contract.createSignatureRequest(signArgs);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const pollResult = await contract.pollForRequestId({
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

  const respondLogs = await publicClient.getContractEvents({
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
  contract: MpcContract,
  evmAdapter: EvmAdapter,
  programId: PublicKey,
  nonce: bigint,
  remainingAccountKeys: PublicKey[],
  indexedInstructions: IndexedInnerInstruction[],
  path: string
): Promise<{ signature: Buffer; recoveryId: number }> {
  const innerHash = computeInnerHash(programId, nonce, remainingAccountKeys, indexedInstructions);
  const { hashToSign } = await evmAdapter.prepareMessageForSigning({ raw: innerHash });

  const rsv = await contract.sign(
    { payload: hashToSign, path, key_version: 1 },
    { sign: {}, retry: { delay: 5_000, retryCount: 12 } }
  );

  return {
    signature: Buffer.concat([Buffer.from(rsv.r, "hex"), Buffer.from(rsv.s, "hex")]),
    recoveryId: rsv.v - 27,
  };
}
