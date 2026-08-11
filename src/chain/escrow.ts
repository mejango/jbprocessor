import type { Address, Hex } from "viem";
import { concatHex, keccak256, parseEventLogs, stringToHex } from "viem";
import { escrowAbi } from "./abi/escrow.js";
import type { ChainClients } from "./client.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Returns the deployed `JBProcessorEscrow` address from `ESCROW_ADDRESS`.
 * Read fresh from the environment on every call (not memoized) so tests can
 * set/unset it freely; the parse itself is cheap.
 */
export function escrowAddress(): Address {
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
 * Escrow writes take the same injectable client pair the rest of this
 * service uses -- the real `publicClient()`/`walletClient()` singletons
 * from `src/chain/client.ts` (Task 4), or a same-shape override (e.g. a
 * client pointed at an anvil fork in `test/escrow.fork.test.ts`). Reusing
 * `AppPublicClient`/`AppWalletClient` directly (rather than a hand-rolled
 * structural subset, as `quoteTokens`'s read-only `ReadContractClient`
 * does) avoids fighting viem's overloaded `simulateContract`/
 * `writeContract` generics -- see the `client.ts` comment on why bare
 * `PublicClient`/`WalletClient` annotations don't typecheck here.
 */
export type EscrowClients = ChainClients;

const UINT48_MAX = 2 ** 48 - 1;

/**
 * viem/abitype represent Solidity `uintN` for N <= 48 as a JS `number`
 * (not `bigint`) -- `unlockAt` is a `uint48`, so the contract call's args
 * tuple needs a `number` here even though the rest of this module (and the
 * `payments` table) deals in bigints for the wider `uint256` fields.
 * `uint48`'s max value (~2.8e14) is well within `Number`'s safe integer
 * range, so this conversion never loses precision for valid input.
 */
function toUint48(value: bigint | number, fieldName: string): number {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(asNumber) || asNumber < 0 || asNumber > UINT48_MAX) {
    throw new Error(`${fieldName} must be a non-negative integer that fits in a uint48, got: ${value}`);
  }
  return asNumber;
}

function requireAccount(walletClient: ChainClients["walletClient"], fnName: string) {
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
  const unlockAtSeconds = toUint48(params.unlockAt, "unlockAt");
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

export interface EscrowEntry {
  /** The project token the escrow is holding. */
  token: Address;
  /** How many project tokens are held for this payment. */
  amount: bigint;
  /** Unix seconds. */
  unlockAt: number;
  settled: boolean;
  beneficiary: Address;
  pendingBeneficiary: Address;
  /** Unix seconds; 0 when no redirect is pending. */
  redirectEffectiveAt: number;
}

/**
 * Reads `entries(paymentId)`, returning null when the escrow has never
 * recorded this payment.
 *
 * The existence sentinel is `unlockAt != 0`, matching the contract's own
 * checks (`if (entries[paymentId].unlockAt != 0) revert EntryExists()` in
 * `processPayment`, `if (entry.unlockAt == 0) revert NoEntry()` everywhere
 * else) -- `processPayment` rejects a zero `unlockAt`, so a written entry
 * always has a non-zero one. This is what lets the payer worker tell "my
 * previous attempt crashed before sending" from "it crashed after sending",
 * without which a retry would double-pay.
 */
export async function getEntry(
  { publicClient }: Pick<EscrowClients, "publicClient">,
  paymentId: Hex,
): Promise<EscrowEntry | null> {
  const [
    token,
    amount,
    unlockAt,
    settled,
    beneficiary,
    pendingBeneficiary,
    redirectEffectiveAt,
  ] = await publicClient.readContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "entries",
    args: [paymentId],
  });

  if (unlockAt === 0) return null;

  return {
    token,
    amount,
    unlockAt,
    settled,
    beneficiary,
    pendingBeneficiary,
    redirectEffectiveAt,
  };
}

export interface SetBeneficiaryParams {
  paymentId: Hex;
  to: Address;
}

export interface SetBeneficiaryResult {
  txHash: Hex;
}

/**
 * Waits for a sent write to be mined and asserts it succeeded.
 *
 * A simulation that passed is not a transaction that landed: the chain can
 * still reorder, run out of gas, or revert against state that moved between
 * the simulation and inclusion. Every caller here records the hash as fact
 * (`release_tx`, `claim_address`), so "sent" is never good enough -- the
 * receipt is what makes the write true.
 */
async function confirm(
  publicClient: EscrowClients["publicClient"],
  txHash: Hex,
  fnName: string,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`${fnName}: transaction ${txHash} reverted onchain`);
  }
}

/**
 * Calls `JBProcessorEscrow.setBeneficiary`. Simulates, writes, and waits for
 * the receipt. Note the contract enforces a 48h `REDIRECT_DELAY` before the
 * redirect takes effect -- this call only queues it (see `BeneficiaryChanged`).
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
  await confirm(publicClient, txHash, "setBeneficiary");
  return { txHash };
}

export interface ForfeitParams {
  paymentId: Hex;
}

export interface ForfeitResult {
  txHash: Hex;
}

/**
 * Calls `JBProcessorEscrow.forfeit`, clawing an entry's tokens back to the
 * operator instead of delivering them to the payer. Operator-gated onchain.
 *
 * Reached from exactly one place: a chargeback on a payment whose tokens are
 * already escrowed. Simulates first so `NoEntry` / `AlreadySettled` surface as
 * such (the dispute handler distinguishes those from real faults -- a release
 * that raced the dispute is a manual-recovery case, not a job to retry), and
 * waits for the receipt, because the alert this triggers tells an operator the
 * tokens are back and ready to cash out.
 */
export async function forfeit(
  { publicClient, walletClient }: EscrowClients,
  params: ForfeitParams,
): Promise<ForfeitResult> {
  const account = requireAccount(walletClient, "forfeit");
  const { request } = await publicClient.simulateContract({
    address: escrowAddress(),
    abi: escrowAbi,
    functionName: "forfeit",
    args: [params.paymentId],
    account,
  });
  const txHash = await walletClient.writeContract(request);
  await confirm(publicClient, txHash, "forfeit");
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
 * `AlreadySettled` / `RedirectPending` reverts surface before sending, then
 * waits for the receipt: the keeper writes `release_tx` and moves the payment
 * to `claimed` off the back of this call, and neither may happen for a
 * transaction that never landed.
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
  await confirm(publicClient, txHash, "release");
  return { txHash };
}
