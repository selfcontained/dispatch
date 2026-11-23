import { runLocalRunner, type Build } from "./local/child.js";
import type { Platform } from "./platform/types.js";

export type {
  Platform,
  Workload,
  WorkerOp,
  WorkerInput,
} from "./platform/types.js";
export { WORKER_OPS } from "./platform/types.js";

/**
 * The runner's standalone entry. The embedding binary passes its own build,
 * which the launcher handshake compares exactly with the parent's.
 */
export async function runCli(
  argv: string[],
  options: { build: Build; platform?: Platform }
): Promise<void> {
  const [mode] = argv;
  if (mode === "local-runner")
    return runLocalRunner(options.build, { platform: options.platform });
  process.stderr.write(`Unknown runner mode: ${mode ?? "(none)"}\n`);
  process.exitCode = 2;
}
