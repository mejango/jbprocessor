import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnAnvil } from "./support/anvil.js";

describe.skipIf(spawnSync("anvil", ["--version"]).status !== 0)("test Anvil", () => {
  it("writes no block state to disk and keeps recent history", async () => {
    const server = createServer();
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(done => server.close(() => done()));
    // Unpruned, Anvil writes hundreds of states into the cache path for 1,000 blocks.
    const cache = await mkdtemp(join(tmpdir(), "anvil-cache-"));
    const rpc = async (method: string, params: unknown[] = []) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
    const child = spawnAnvil(["--port", String(port), "--cache-path", cache, "--silent"]);
    const stopped = new Promise(done => { child.once("exit", done); child.once("error", done); });
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await stopped; };
    try {
      for (let i = 0; i < 100; i++) {
        try { await rpc("eth_chainId"); break; } catch { await new Promise(done => setTimeout(done, 30)); }
      }
      expect(await rpc("anvil_mine", ["0x3e8"])).toMatchObject({ result: null });
      // Bare --prune-history would keep no history at all.
      expect(await rpc("eth_getBalance", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x258"])).toMatchObject({ result: expect.any(String) });
      await stop();
      expect(await readdir(cache, { recursive: true })).toEqual([]);
    } finally {
      await stop();
      await rm(cache, { recursive: true, force: true });
    }
  });
});

it("starts every test Anvil through the helper", () => {
  const direct = readdirSync("test").filter(file => file.endsWith(".ts") && file !== "anvil-support.test.ts")
    .filter(file => /spawn(Sync)?\(\s*["']anvil["']/.test(readFileSync(join("test", file), "utf8")));
  expect(direct).toEqual([]);
});
