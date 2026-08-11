import type { Address, Hex } from "viem";
import { concatHex, keccak256, parseEventLogs, stringToHex } from "viem";
import { escrowAbi } from "./abi/escrow.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Returns the deployed `JBProcessorEscrow` address from `ESCROW_ADDRESS`.
 * Read fresh from the environment on every call (not memoized) so tests can
 * set/unset it freely; the parse itself is cheap.
 */
function escrowAddress(): Address {
  const value = process.env.ESCROW_ADDRESS;
  if (!value) {
    throw new Error("ESCROW_ADDRESS environment variable is not set");
  }
  if (!ADDRESS_PATTERN.test(value)) {
    throw new Error(
      `ESCROW_ADDRESS must be a 0x-prefixed 20-byte hex address, got: ${value}`,
    );
  }
  return value as Address;
}

/**
 * Converts a payment's UUID (the Postgres `uuid` primary key on the
 * `payments` table, e.g. "550e8400-e29b-41d4-a716-446655440000") into the
 * `bytes32 paymentId` the escrow contract keys its `entries` mapping by.
 *
 * Byte order: dashes are stripped, leaving the UUID's 16 raw bytes (32 hex
 * chars). Those bytes occupy the LOW/right-hand 16 bytes of the returned
 * bytes32 -- the value is left-padded with 16 zero bytes, e.g.
 *   "550e8400-e29b-41d4-a716-446655440000"
 *   -> 0x00000000000000000000000000000000 + 550e8400e29b41d4a716446655440000
 * This is zero-extension (like widening a uint128 into a uint256), NOT a
 * reinterpretation of the UUID's own 16-byte layout as a 32-byte value.
 * `feePaymentId` hashes this padded 32-byte form, so the padding is
 * load-bearing for every downstream call into the escrow contract.
 */
export function paymentIdBytes32(uuid: string): Hex {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`paymentIdBytes32: not a valid UUID: ${uuid}`);
  }
  const stripped = uuid.replace(/-/g, "").toLowerCase();
  return `0x${stripped.padStart(64, "0")}` as Hex;
}

/**
 * Derives a fee sub-payment id from a primary paymentId: a second,
 * deterministic bytes32 id used to key a separate escrow entry for the
 * protocol-fee portion split off the same underlying payment (so both
 * entries can be processed/released independently under the same escrow
 * contract, without colliding on the primary paymentId).
 *
 * Matches the Solidity convention `keccak256(abi.encodePacked(paymentId,
 * "fee"))` -- the paymentId's 32 raw bytes concatenated with the 3 ASCII
 * bytes of "fee", then hashed. Cross-checked against `cast keccak`, see
 * `test/escrow.test.ts`.
 */
export function feePaymentId(paymentId: Hex): Hex {
  if (!BYTES32_PATTERN.test(paymentId)) {
    throw new Error(
      `feePaymentId: paymentId must be a 32-byte (0x + 64 hex chars) value, got: ${paymentId}`,
    );
  }
  return keccak256(concatHex([paymentId, stringToHex("fee")]));
}

/**
 * The minimal slice of a viem PublicClient that escrow writes need --
 * simulate-then-write, plus waiting for the confirmation used to parse
 * `processPayment`'s `Processed` event. Lets tests pass a stub instead of a
 * real viem client, same pattern as `quoteTokens`'s `ReadContractClient`
 * (`src/chain/quote.ts`).
 */
export interface EscrowPublicClient {
  simulateContract(args: {
    address: Address;
    abi: typeof escrowAbi;
    functionName: string;
    args: readonly unknown[];
    account: unknown;
  }): Promise<{ request: unknown }>;
  waitForTransactionReceipt(args: {
    hash: Hex;
  }): Promise<{ logs: readonly unknown[] }>;
}

/** The minimal slice of a viem WalletClient that escrow writes need. */
export interface EscrowWalletClient {
  account: { address: Address } | null | undefined;
  writeContract(request: unknown): Promise<Hex>;
}

export interface EscrowClients {
  publicClient: EscrowPublicClient;
  walletClient: EscrowWalletClient;
}

function requireAccount(walletClient: EscrowWalletClient, fnName: string) {
  const account = walletClient.account;
  if (!account) {
    throw new Error(`${fnName}: walletClient has no account configured`);
  }
  return account;
}

export interface ProcessPaymentParams {
  paymentId: Hex;
  terminal: Address;
  projectId: bigint;
  usdcAmountWei: bigint;
  minReturnedTokens: bigint;
  projectToken: Address;
  beneficiary: Address;
  /** Unix seconds. Passed to the contract as a uint48. */
  unlockAt: bigint | number;
  memo: string;
}

export interface ProcessPaymentResult {
  txHash: Hex;
  tokensHeld: bigint;
}

/**
 * Calls `JBProcessorEscrow.processPayment`: simulates first (so a would-be
 * revert -- e.g. `EntryExists`, `ZeroUnlock`, `ZeroBeneficiary` -- surfaces
 * before any gas is spent), sends the write, waits for one confirmation,
 * then parses the confirmation's `Processed` event to read back
 * `tokensHeld` (the contract computes this from actual balances, so it
 * isn't something the caller can compute locally).
 */
export async function processPayment(
  { publicClient, walletClient }: EscrowClients,
  params: ProcessPaymentParams,
): Promise<ProcessPaymentResult> {
  const account = requireAccount(walletClient, "processPayment");
  const unlockAtSeconds = BigInt(params.unlockAt);
  const address = escrowAddress();

  const { request } = await publicClient.simulateContract({
    address,
    abi: escrowAbi,
    functionName: "processPayment",
    args: [
      params.paymentId,
      params.terminal,
      params.projectId,
      params.usdcAmountWei,
      params.minReturnedTokens,
      params.projectToken,
      params.beneficiary,
      unlockAtSeconds,
      params.memo,
    ],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const events = parseEventLogs({
    abi: escrowAbi,
    eventName: "Processed",
    logs: receipt.logs as Parameters<typeof parseEventLogs>[0]["logs"],
  });
  // This viem version's parseEventLogs has no built-in `address` filter, so
  // scope the match to this escrow's own address (in case the receipt
  // contains logs from other contracts) as well as this specific paymentId
  // (in case a future caller batches multiple processPayment calls into one
  // tx -- unlikely today, but cheap to guard against).
  const processedEvent = events.find(
    (event) =>
      event.address.toLowerCase() === address.toLowerCase() &&
      event.args.paymentId === params.paymentId,
  );
  if (!processedEvent) {
    throw new Error(
      `processPayment: no Processed event for paymentId ${params.paymentId} found in receipt for tx ${txHash}`,
    );
  }

  return { txHash, tokensHeld: processedEvent.args.tokensHeld };
}

export interface SetBeneficiaryParams {
  paymentId: Hex;
  to: Address;
}

export interface SetBeneficiaryResult {
  txHash: Hex;
}

/**
 * Calls `JBProcessorEscrow.setBeneficiary`. Simulates first, then writes.
 * Note the contract enforces a 48h `REDIRECT_DELAY` before the redirect
 * takes effect -- this call only queues it (see `BeneficiaryChanged`).
 */
export async function setBeneficiary(
  { publicClient, walletClient }: EscrowClients,
  params: SetBeneficiaryParams,
): Promise<SetBeneficiaryResult> {
  const account = requireAccount(walletClient, "setBeneficiary");
  const { request } = await publicClient.simulateContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "setBeneficiary",
    args: [params.paymentId, params.to],
    account,
  });
  const txHash = await walletClient.writeContract(request);
  return { txHash };
}

export interface ReleaseParams {
  paymentId: Hex;
}

export interface ReleaseResult {
  txHash: Hex;
}

/**
 * Calls `JBProcessorEscrow.release`. Permissionless onchain (no operator
 * check in the contract) -- any funded account can crank an unlocked entry
 * -- but a signer is still required locally to pay gas, so `walletClient`
 * still needs an account. Simulates first so `StillLocked` /
 * `AlreadySettled` / `RedirectPending` reverts surface before sending.
 */
export async function release(
  { publicClient, walletClient }: EscrowClients,
  params: ReleaseParams,
): Promise<ReleaseResult> {
  const account = requireAccount(walletClient, "release");
  const { request } = await publicClient.simulateContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "release",
    args: [params.paymentId],
    account,
  });
  const txHash = await walletClient.writeContract(request);
  return { txHash };
}
