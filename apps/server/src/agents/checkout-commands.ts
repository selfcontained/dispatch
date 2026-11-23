import {
  checkoutCommandTimeoutMs,
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
  signal?: AbortSignal
): Promise<CheckoutCommandResult>;
export async function requestCheckoutCommand(
  runners: CheckoutCommandRunners,
  agent: CheckoutSession,
  operation: CheckoutCommand,
  signal?: AbortSignal
) {
  const { directory, placement } = checkoutRunners(runners, agent);
  const runner = directory.for(placement);
  if (operation.kind === "read") return runner.readManifest(operation, signal);
  return runner.call(
    "checkout.exec",
    {
      target: {
        session: sessionFromWire(agent.id),
        checkout:
          operation.checkout === "effective" ? "current" : operation.checkout,
      },
      guard: { path: operation.path, digest: operation.state },
      argv: operation.argv,
      env: {},
      timeoutMs:
        operation.checkout === "effective"
          ? null
          : checkoutCommandTimeoutMs(operation.checkout),
      maxOutput: null,
      shell: "direct",
    },
    { signal }
  );
}
