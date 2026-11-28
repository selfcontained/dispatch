import {
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import {
  checkoutRunners,
  type CheckoutCommandRunners,
  type CheckoutSession,
} from "../runners/directory.js";

export type { CheckoutCommandRunners } from "../runners/directory.js";

/** Main's lifecycle hook deadline. Repo tools have none. */
const HOOK_TIMEOUT_MS = 15_000;

export async function requestCheckoutCommand(
  runners: CheckoutCommandRunners,
  agent: CheckoutSession,
  operation: Extract<CheckoutCommand, { kind: "read" }>,
  signal?: AbortSignal
): Promise<CheckoutCommandFile | null>;
export async function requestCheckoutCommand(
  runners: CheckoutCommandRunners,
  agent: CheckoutSession,
  operation: Extract<CheckoutCommand, { kind: "run" }>,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<CheckoutCommandResult>;
export async function requestCheckoutCommand(
  runners: CheckoutCommandRunners,
  agent: CheckoutSession,
  operation: CheckoutCommand,
  signal?: AbortSignal,
  timeoutMs = HOOK_TIMEOUT_MS
) {
  const { directory, placement } = checkoutRunners(runners, agent);
  const runner = directory.for(placement);
  const target = {
    session: sessionFromWire(agent.id),
    checkout:
      operation.checkout === "effective"
        ? ("current" as const)
        : operation.checkout,
  };
  if (operation.kind === "read") {
    const file = await runner.call(
      "checkout.read",
      {
        target,
        mode: "command-manifest",
        path: operation.path,
        encoding: "utf8",
        maxBytes: runner.manifestMaxBytes,
      },
      { signal }
    );
    if (!file) return null;
    if (!file.digest) throw new Error("Missing checkout command guard.");
    return { content: file.data, state: file.digest };
  }
  return runner.call(
    "checkout.exec",
    {
      target,
      guard: { path: operation.path, digest: operation.state },
      argv: operation.argv,
      // Dispatch's terms for every runner: main's environment addition and
      // deadline, no output limit, a direct spawn.
      env: { DISPATCH_AGENT_ID: agent.id },
      timeoutMs: operation.checkout === "effective" ? null : timeoutMs,
      maxOutput: null,
      shell: "direct",
    },
    { signal }
  );
}
