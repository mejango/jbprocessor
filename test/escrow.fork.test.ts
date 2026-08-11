import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escrowAbi } from "../src/chain/abi/escrow.js";
import { paymentIdBytes32, processPayment, release } from "../src/chain/escrow.js";
import { USDC_ON_BASE } from "../src/chain/quote.js";

/**
 * Fork test for the escrow write module against a real anvil fork of Base.
 * Skipped entirely unless FORK_RPC_URL is set -- this suite is exercised
 * manually (`FORK_RPC_URL=... npx vitest run escrow.fork`), not in the
 * default `npm test` run, so it must never fail (or hang) when unset.
 *
 * Also needs, when actually run:
 *   TEST_PROJECT_ID     -- a live Juicebox V6 project id with a working
 *                           terminal that accepts USDC and issues a token.
 *   TEST_PROJECT_TOKEN  -- that project's ERC-20 token address.
 *   TEST_TERMINAL       -- that project's terminal address.
 *   TEST_USDC_WHALE     -- optional; an address with a large USDC balance
 *                           on Base to impersonate as the payment funding
 *                           source. Defaults to a well-known large Base USDC
 *                           holder, but per the task controller's note this
 *                           value was NOT hunted down/verified live -- an
 *                           operator running this suite for real should
 *                           confirm the default (or their override) actually
 *                           holds enough USDC on the forked block before
 *                           trusting a red result to mean something's broken
 *                           in the escrow module itself.
 *
 * None of this is required for `npm test` to pass -- with FORK_RPC_URL
 * unset, `describe.skipIf` skips the whole suite before any of it runs.
 */
const FORK_RPC_URL = process.env.FORK_RPC_URL;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
// A syntactically-valid but otherwise arbitrary placeholder -- deliberately
// NOT a real known whale. Per the task controller's note, this suite isn't
// meant to have live values hunted down for it; without a real
// TEST_USDC_WHALE override this placeholder will just fail cleanly at the
// USDC-funding step (0 balance to transfer) rather than silently
// proceeding on an unverified guess. Set TEST_USDC_WHALE to a real address
// holding USDC on Base at the fork block to actually run this suite.
const RAW_TEST_USDC_WHALE = process.env.TEST_USDC_WHALE ?? "0x6d0073A19b14071F8451074Fc8464E3D323AFb12";
if (!ADDRESS_PATTERN.test(RAW_TEST_USDC_WHALE)) {
  throw new Error(`TEST_USDC_WHALE must be a 0x-prefixed 20-byte hex address, got: ${RAW_TEST_USDC_WHALE}`);
}
const TEST_USDC_WHALE = RAW_TEST_USDC_WHALE as Address;

const ANVIL_PORT = 8646;
const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
// anvil's well-known default dev account #0 (deterministic test mnemonic) --
// used here as the escrow's owner/operator and the tx sender/gas payer for
// every non-impersonated call in this suite.
const ANVIL_DEFAULT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = join(
  __dirname,
  "..",
  "contracts",
  "out",
  "JBProcessorEscrow.sol",
  "JBProcessorEscrow.json",
);

function loadEscrowBytecode(): Hex {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as {
    bytecode: { object: Hex };
  };
  return artifact.bytecode.object;
}

async function waitForAnvil(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`anvil did not become ready at ${url}: ${String(lastError)}`);
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) {
    throw new Error(`${method} failed: ${body.error.message}`);
  }
  return body.result;
}

describe.skipIf(!FORK_RPC_URL)("escrow (anvil fork)", () => {
  let anvil: ChildProcessWithoutNullStreams;
  let escrowAddress: Address;
  const deployer = privateKeyToAccount(ANVIL_DEFAULT_KEY);

  const localPublicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC_URL) });
  const deployerWalletClient = createWalletClient({
    account: deployer,
    chain: base,
    transport: http(ANVIL_RPC_URL),
  });
  // Impersonated account -- no private key. viem sends unsigned
  // eth_sendTransaction requests for a plain-address account, which anvil
  // fulfills for any address passed to anvil_impersonateAccount.
  const whaleWalletClient = createWalletClient({
    account: TEST_USDC_WHALE,
    chain: base,
    transport: http(ANVIL_RPC_URL),
  });

  let projectId: bigint;
  let projectToken: Address;
  let terminal: Address;

  beforeAll(async () => {
    if (!process.env.TEST_PROJECT_ID || !process.env.TEST_PROJECT_TOKEN || !process.env.TEST_TERMINAL) {
      throw new Error(
        "escrow fork test: FORK_RPC_URL is set but TEST_PROJECT_ID/TEST_PROJECT_TOKEN/TEST_TERMINAL are not -- see the comment at the top of test/escrow.fork.test.ts",
      );
    }
    projectId = BigInt(process.env.TEST_PROJECT_ID);
    projectToken = process.env.TEST_PROJECT_TOKEN as Address;
    terminal = process.env.TEST_TERMINAL as Address;

    anvil = spawn(
      "anvil",
      ["--fork-url", FORK_RPC_URL as string, "--port", String(ANVIL_PORT), "--silent"],
      { stdio: "pipe" },
    );
    await waitForAnvil(ANVIL_RPC_URL);

    // Deploy JBProcessorEscrow(owner_ = deployer, operator_ = deployer, usdc = USDC_ON_BASE).
    const bytecode = loadEscrowBytecode();
    const deployHash = await deployerWalletClient.deployContract({
      abi: escrowAbi,
      bytecode,
      args: [deployer.address, deployer.address, USDC_ON_BASE],
    });
    const deployReceipt = await localPublicClient.waitForTransactionReceipt({ hash: deployHash });
    if (!deployReceipt.contractAddress) {
      throw new Error("escrow deployment did not return a contractAddress");
    }
    escrowAddress = deployReceipt.contractAddress;
    process.env.ESCROW_ADDRESS = escrowAddress;

    // Fund the deployer (operator) with USDC by impersonating a whale.
    await rpc(ANVIL_RPC_URL, "anvil_impersonateAccount", [TEST_USDC_WHALE]);
    await rpc(ANVIL_RPC_URL, "anvil_setBalance", [
      TEST_USDC_WHALE,
      `0x${(10n ** 18n).toString(16)}`, // 1 ETH for gas
    ]);
    const fundAmount = 1_000_000_000n; // 1,000 USDC (6 decimals)
    const transferHash = await whaleWalletClient.writeContract({
      address: USDC_ON_BASE,
      abi: erc20Abi,
      functionName: "transfer",
      args: [deployer.address, fundAmount],
    });
    await localPublicClient.waitForTransactionReceipt({ hash: transferHash });
    await rpc(ANVIL_RPC_URL, "anvil_stopImpersonatingAccount", [TEST_USDC_WHALE]);

    // Operator approves the escrow to pull USDC via safeTransferFrom.
    const approveHash = await deployerWalletClient.writeContract({
      address: USDC_ON_BASE,
      abi: erc20Abi,
      functionName: "approve",
      args: [escrowAddress, fundAmount],
    });
    await localPublicClient.waitForTransactionReceipt({ hash: approveHash });
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("processPayment records an escrow entry and returns tokensHeld", async () => {
    const paymentId = paymentIdBytes32("11111111-1111-4111-8111-111111111111");
    const beneficiary = getAddress(`0x${"b0".padStart(40, "0")}`);
    const block = await localPublicClient.getBlock();
    const unlockAt = block.timestamp + 3600n; // +1h

    const result = await processPayment(
      { publicClient: localPublicClient, walletClient: deployerWalletClient },
      {
        paymentId,
        terminal,
        projectId,
        usdcAmountWei: 100_000_000n, // 100 USDC
        minReturnedTokens: 0n,
        projectToken,
        beneficiary,
        unlockAt,
        memo: "juice-processor fork test",
      },
    );

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.tokensHeld).toBeGreaterThan(0n);

    const entry = await localPublicClient.readContract({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "entries",
      args: [paymentId],
    });
    // Entry: [token, amount, unlockAt, settled, beneficiary, pendingBeneficiary, redirectEffectiveAt]
    expect(entry[0].toLowerCase()).toBe(projectToken.toLowerCase());
    expect(entry[1]).toBe(result.tokensHeld);
    // entry[2] (unlockAt) decodes as a `number` (uint48 <= 48 bits maps to
    // `number` in viem/abitype, unlike the wider uint256 fields elsewhere in
    // this entry, which decode as `bigint`) -- compare against the same type.
    expect(entry[2]).toBe(Number(unlockAt));
    expect(entry[3]).toBe(false);
    expect(entry[4].toLowerCase()).toBe(beneficiary.toLowerCase());
  });

  it("release reverts before unlockAt and succeeds after warping past it", async () => {
    const paymentId = paymentIdBytes32("22222222-2222-4222-8222-222222222222");
    const beneficiary = getAddress(`0x${"b1".padStart(40, "0")}`);
    const block = await localPublicClient.getBlock();
    const unlockAt = block.timestamp + 3600n; // +1h

    await processPayment(
      { publicClient: localPublicClient, walletClient: deployerWalletClient },
      {
        paymentId,
        terminal,
        projectId,
        usdcAmountWei: 50_000_000n, // 50 USDC
        minReturnedTokens: 0n,
        projectToken,
        beneficiary,
        unlockAt,
        memo: "juice-processor fork test (release)",
      },
    );

    // Still locked -- release must revert (StillLocked).
    await expect(
      release(
        { publicClient: localPublicClient, walletClient: deployerWalletClient },
        { paymentId },
      ),
    ).rejects.toThrow();

    // Warp past unlockAt.
    await rpc(ANVIL_RPC_URL, "evm_increaseTime", [3601]);
    await rpc(ANVIL_RPC_URL, "evm_mine", []);

    const beforeBalance = await localPublicClient.readContract({
      address: projectToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [beneficiary],
    });

    // release is permissionless onchain -- calling it with the deployer's
    // wallet client here just because it's the signer this suite already
    // has on hand, not because the contract requires it.
    const releaseResult = await release(
      { publicClient: localPublicClient, walletClient: deployerWalletClient },
      { paymentId },
    );
    expect(releaseResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const afterBalance = await localPublicClient.readContract({
      address: projectToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [beneficiary],
    });
    expect(afterBalance).toBeGreaterThan(beforeBalance);

    const entry = await localPublicClient.readContract({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "entries",
      args: [paymentId],
    });
    expect(entry[3]).toBe(true); // settled
  });
});
