import { runLocalRunner, type Build } from "./local/child.js";

/**
 * The runner's standalone entry. The embedding binary passes its own build,
 * which the launcher handshake compares exactly with the parent's.
 */
export async function runCli(
  argv: string[],
  options: { build: Build }
): Promise<void> {
  const [mode] = argv;
  if (mode === "local-runner") return runLocalRunner(options.build);
  process.stderr.write(`Unknown runner mode: ${mode ?? "(none)"}\n`);
  process.exitCode = 2;
}
