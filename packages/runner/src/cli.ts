import { runLocalRunner, type Build } from "./local/child.js";

export type {
  EnginePort,
  GitHubPort,
  Platform,
  Workload,
  WorkerOp,
  WorkerInput,
} from "./platform/types.js";
export { WORKER_OPS } from "./platform/types.js";
export type { PosixHostEntry } from "./platform/posix-user/sessions.js";

/**
 * The runner's standalone entry. The embedding binary passes its own build,
 * which the launcher handshake compares exactly with the parent's.
 */
export async function runCli(
  argv: string[],
  options: { build: Build } & NonNullable<Parameters<typeof runLocalRunner>[1]>
): Promise<void> {
  const [mode] = argv;
  if (mode === "local-runner") return runLocalRunner(options.build, options);
  process.stderr.write(`Unknown runner mode: ${mode ?? "(none)"}\n`);
  process.exitCode = 2;
}

export { createRemoteWorkspacePreparation } from "./platform/linux-privsep/index.js";
export { createSessionCore } from "./core/sessions.js";
export { localSessionHandlers } from "./local/sessions.js";

export type { AgentHostOptions } from "./host/main.js";

import { runAgentHost as runHost, type AgentHostOptions } from "./host/main.js";
import {
  ownedEnvironment,
  killOwnedProcesses,
} from "./workload/shared/process/owned-processes.js";

export function runAgentHost(
  argv: string[],
  options: Omit<AgentHostOptions, "ownership">
) {
  return runHost(argv, {
    ...options,
    ownership: { ownedEnvironment, killOwnedProcesses },
  });
}
