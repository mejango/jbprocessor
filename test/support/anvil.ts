import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Every test chain starts here. */
export function spawnAnvil(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn("anvil", args, { stdio: "pipe" });
}
