import type { Address, Hex } from "viem";
import { erc20Abi } from "./abi/erc20.js";
import type { ChainClients } from "./client.js";

/** Reads an ERC-20 balance. */
export async function balanceOf(
  { publicClient }: Pick<ChainClients, "publicClient">,
  token: Address,
  account: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

export interface TransferFromParams {
  token: Address;
  /** Whose balance is being spent -- must have approved the wallet client's account. */
  from: Address;
  to: Address;
  amount: bigint;
}

/**
 * Draws `amount` of `token` from `from` to `to` against a standing allowance,
 * simulating first (so a shortfall in balance or allowance surfaces as a clear
 * revert before gas is spent) and waiting for one confirmation.
 *
 * Waiting is load-bearing, not politeness: the caller's very next action
 * spends the drawn funds, and simulating that spend against a node that
 * hasn't seen this transfer yet would revert on an insufficient balance.
 */
export async function transferFrom(
  { publicClient, walletClient }: ChainClients,
  params: TransferFromParams,
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) {
    throw new Error("transferFrom: walletClient has no account configured");
  }

  const { request } = await publicClient.simulateContract({
    address: params.token,
    abi: erc20Abi,
    functionName: "transferFrom",
    args: [params.from, params.to, params.amount],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`transferFrom: tx ${txHash} reverted`);
  }
  return txHash;
}
