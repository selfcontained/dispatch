import {
  RunnerCallError,
  sessionToWire,
  type CallName,
  type Req,
  type Res,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import type {
  CheckoutCommand,
  CheckoutCommandFile,
  CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import type {
  CheckoutRunner,
  CheckoutSession,
  LocalCheckoutRunner,
} from "./directory.js";

export function createLocalCheckoutRunner(
  local: LocalCheckoutRunner,
  agent: CheckoutSession | undefined,
  description: RunnerDescription
): CheckoutRunner {
  async function requestCheckout(operation: CheckoutCommand) {
    if (!agent)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout command binding.",
      });
    const { value } = await local.requestSession(
      { kind: "checkoutCommand", agentId: agent.id, operation },
      { checkout: agent }
    );
    try {
      return typeof value === "string"
        ? (JSON.parse(value) as unknown)
        : undefined;
    } catch {
      throw new Error("Invalid runner checkout command response.");
    }
  }

  return {
    describe: () => description,
    connection: { state: "ready", epoch: 0, onChange: () => () => {} },
    async readManifest(operation) {
      return (await requestCheckout(operation)) as CheckoutCommandFile | null;
    },
    async call<K extends CallName>(op: K, input: Req<K>): Promise<Res<K>> {
      if (op === "runner.describe") return description as Res<K>;
      if (op !== "checkout.exec")
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });

      const { target, guard, argv } = input as Req<"checkout.exec">;
      if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid native checkout command binding.",
        });
      return (await requestCheckout({
        checkout:
          target.checkout === "current"
            ? "effective"
            : (target.checkout ?? "effective"),
        path: guard.path,
        kind: "run",
        state: guard.digest,
        argv,
      })) as CheckoutCommandResult as Res<K>;
    },
    async open(op) {
      throw new RunnerCallError({
        code: "unsupported",
        message: `Unsupported operation: ${op}`,
      });
    },
  };
}
