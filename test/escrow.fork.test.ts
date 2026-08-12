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
import {
  ANVIL_DEFAULT_KEY,
  FORK_PROJECT_ID,
  FORK_PROJECT_TOKEN,
  FORK_TERMINAL,
  FORK_TEST_TIMEOUT_MS,
  FORK_USDC_WHALE,
} from "./fork-addresses.js";

/**
 * Fork test for the escrow write module against a real anvil fork of Base.
 * Skipped entirely unless FORK_RPC_URL is set -- this suite is exercised
 * manually, not in the default `npm test` run, so it must never fail (or
 * hang) when unset:
 *
 *   FORK_RPC_URL=https://mainnet.base.org npx vitest run escrow.fork
 *
 * Every address it needs has a verified Base mainnet default in
 * `test/fork-addresses.ts`, each overridable by environment variable. With
 * FORK_RPC_URL unset, `describe.skipIf` skips the whole suite before any of
 * it runs.
 */
const FORK_RPC_URL = process.env.FORK_RPC_URL;

const ANVIL_PORT = 8646;
const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

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
    account: FORK_USDC_WHALE,
    chain: base,
    transport: http(ANVIL_RPC_URL),
  });

  const projectId = FORK_PROJECT_ID;
  const projectToken = FORK_PROJECT_TOKEN;
  const terminal = FORK_TERMINAL;

  beforeAll(async () => {
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
    await rpc(ANVIL_RPC_URL, "anvil_impersonateAccount", [FORK_USDC_WHALE]);
    await rpc(ANVIL_RPC_URL, "anvil_setBalance", [
      FORK_USDC_WHALE,
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
    await rpc(ANVIL_RPC_URL, "anvil_stopImpersonatingAccount", [FORK_USDC_WHALE]);

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
  }, FORK_TEST_TIMEOUT_MS);

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
  }, FORK_TEST_TIMEOUT_MS);
});
