import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Every test chain starts here. Unpruned, Anvil writes block states to ~/.foundry/anvil/tmp and leaves
 * them behind when stopped. Pruning keeps the newest 500 states in memory (Anvil's default) and writes
 * none to disk; state before the fork block still comes from the fork RPC.
 */
export function spawnAnvil(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn("anvil", [...args, "--prune-history", "500"], { stdio: "pipe" });
}
