import {
  isCheckoutCommandFile,
  isCheckoutReadName,
  type CheckoutView,
  isCheckoutCommandResult,
  type Placement as V1Placement,
  type ResultFrame,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  operations,
  sessionToWire,
  type CallName,
  type CallOptions,
  type Req,
  type Res,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import {
  decodeResult,
  encodeCommand,
  type Decoded,
} from "@dispatch/runner-client/v1";
import type { RemoteRunnerService } from "../../agents/remote/service.js";
import { callCheckoutRead } from "./reads.js";
import type { CheckoutRunner, CheckoutSession } from "../directory.js";

function parseResult(value: ResultFrame["value"]) {
  try {
    return typeof value === "string"
      ? (JSON.parse(value) as unknown)
      : undefined;
  } catch {
    throw new Error("Invalid runner checkout command response.");
  }
}

export function createEnrolledCheckoutRunner(
  service: RemoteRunnerService | undefined,
  runnerId: string,
  placement: V1Placement | null,
  agent: CheckoutSession | undefined,
  describe: () => RunnerDescription,
  legacyView?: CheckoutView
): CheckoutRunner {
  return {
    describe,
    connection: {
      get state() {
        return service?.connectionEpoch?.(runnerId) === undefined
          ? "unavailable"
          : "ready";
      },
      get epoch() {
        return service?.lastConnectionEpoch?.(runnerId) ?? 0;
      },
      onChange(listener) {
        return (
          service?.onConnectionChange?.((id) => {
            if (id === runnerId) listener(this.state);
          }) ?? (() => {})
        );
      },
    },
    async readManifest(operation, signal) {
      if (!service) throw new Error("The session runner is unavailable.");
      if (!placement || !agent)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid checkout command binding.",
        });
      const { value } = await service.requestSession(
        placement,
        { kind: "checkoutCommand", agentId: agent.id, operation },
        undefined,
        signal
      );
      const result = parseResult(value);
      if (isCheckoutCommandFile(result)) return result;
      throw new Error("Invalid runner checkout command response.");
    },
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op === "runner.describe") return describe() as Res<K>;
      if (isCheckoutReadName(op))
        return callCheckoutRead(
          service,
          placement,
          agent,
          op,
          input as never,
          options?.signal,
          legacyView
        ) as Promise<Res<K>>;
      if (op !== "checkout.exec" && op !== "git.context")
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });
      if (!service) throw new Error("The session runner is unavailable.");
      if (!placement || !agent)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid checkout command binding.",
        });

      const request = input as Req<"checkout.exec" | "git.context">;
      if (
        !("session" in request.target) ||
        sessionToWire(request.target.session) !== agent.id
      )
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid checkout command binding.",
        });
      if (op === "git.context") {
        const frame: Decoded<"git.context"> = {
          op,
          request,
          extras: { workspace: placement.workspace, agentId: agent.id },
          absent: [],
        };
        const command = encodeCommand(frame);
        if (command.kind !== "sessionCheckout")
          throw new Error("Invalid v1 Git context command.");
        const { value } = await service.requestSession(
          placement,
          command,
          undefined,
          options?.signal
        );
        const context = decodeResult(frame, value);
        if (!operations["git.context"].response.check(context))
          throw new Error("Invalid runner Git context response.");
        return context as Res<K>;
      }

      const execRequest = request as Req<"checkout.exec">;
      const frame: Decoded<"checkout.exec"> = {
        op,
        request: {
          ...execRequest,
          target: {
            ...request.target,
            checkout: request.target.checkout ?? "current",
          },
        },
        extras: { workspace: placement.workspace, agentId: agent.id },
        absent: [],
      };
      const command = encodeCommand(frame);
      if (command.kind !== "checkoutCommand")
        throw new Error("Invalid v1 checkout command.");
      const result = await service.streamCheckoutExec?.(
        placement,
        {
          kind: command.kind,
          agentId: command.agentId,
          operation: command.operation,
          workspace: placement.workspace,
        },
        execRequest,
        options?.signal
      );
      if (result?.streamed) return result.result as Res<K>;
      // Preserve the original legacy envelope, including field order.
      const { value } = await service.requestSession(
        placement,
        {
          kind: command.kind,
          agentId: command.agentId,
          operation: command.operation,
        },
        undefined,
        options?.signal
      );
      if (!isCheckoutCommandResult(parseResult(value)))
        throw new Error("Invalid runner checkout command response.");
      return decodeResult(frame, value) as Res<K>;
    },
    async open(op) {
      throw new RunnerCallError({
        code: "unsupported",
        message: `Unsupported operation: ${op}`,
      });
    },
  };
}
