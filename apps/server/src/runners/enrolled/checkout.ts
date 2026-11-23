import {
  isCheckoutCommandFile,
  remotePlacement,
  isCheckoutReadName,
  type CheckoutView,
  type GitQuery,
  type GitQueryName,
  type CheckoutRelease,
  type CheckoutReleaseResult,
  isCheckoutCommandResult,
  type Placement as V1Placement,
  type SessionOperation,
  type ResultFrame,
  type LaunchProgress,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  operations,
  sessionToWire,
  sessionFromWire,
  type CallName,
  type CallerChannel,
  type CallOptions,
  type OpenName,
  type Req,
  type Res,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import {
  decodeResult,
  encodeCommand,
  ResultError,
  type Decoded,
} from "@dispatch/runner-client/v1";
import { watchChannel } from "@dispatch/runner-client/v1/watch";
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

export function usesBoundArchiveRelease(
  service: RemoteRunnerService,
  cwd: string
): boolean {
  const placement = remotePlacement(cwd);
  return (
    placement !== null && service.supportsWorkspaceRelease?.(placement) === true
  );
}

export function enrolledArchiveCheckout(
  service: RemoteRunnerService,
  placement: V1Placement,
  agentId: string
) {
  const epoch = service.connectionEpoch?.(placement.runner);
  const capable = service.supportsWorkspaceRelease?.(placement) === true;
  const send = (operation: SessionOperation) =>
    epoch === undefined
      ? service.requestSession(placement, operation)
      : service.requestSession(
          placement,
          operation,
          undefined,
          undefined,
          epoch
        );
  const request = (operation: CheckoutRelease) =>
    send({ kind: "checkoutRelease", agentId, operation });
  return {
    capable,
    observe(policy: "ownership" | "changes" = "changes") {
      return request({ kind: "observe", ...(capable && { policy }) });
    },
    async release(
      expectedState: string | null
    ): Promise<CheckoutReleaseResult> {
      const { value } = await request({ kind: "release", expectedState });
      if (value !== "released" && value !== "retained" && value !== "inUse")
        throw new Error("Invalid checkout release result from the runner.");
      return value;
    },
    async releaseBound(operation: Omit<Req<"workspace.release">, "session">) {
      const frame: Decoded<"workspace.release"> = {
        op: "workspace.release",
        request: { session: sessionFromWire(agentId), ...operation },
        absent: [],
        extras: { workspace: placement.workspace },
      };
      const command = encodeCommand(frame);
      if (command.kind !== "workspaceRelease")
        throw new Error("Invalid workspace release command.");
      const { value } = await send(command);
      return decodeResult(frame, value).removed;
    },
  };
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
      if (
        op !== "checkout.exec" &&
        op !== "git.context" &&
        op !== "git.branches" &&
        op !== "git.defaultBranch" &&
        op !== "git.base" &&
        op !== "workspace.select" &&
        op !== "workspace.prepare" &&
        op !== "workspace.resume"
      )
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

      if (op === "workspace.prepare" || op === "workspace.resume") {
        const request = input as Req<"workspace.prepare" | "workspace.resume">;
        if (sessionToWire(request.session) !== agent.id)
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid workspace preparation binding.",
          });
        options?.signal?.throwIfAborted();
        const frame: Decoded<"workspace.prepare" | "workspace.resume"> = {
          op,
          request,
          extras: { workspace: placement.workspace },
          absent: [],
        };
        const command = encodeCommand(frame);
        if (
          command.kind !== "workspacePrepare" &&
          command.kind !== "workspaceResume"
        )
          throw new Error("Invalid v1 workspace preparation command.");
        const { value } = await service.requestSession(
          placement,
          command,
          options?.onEvent as ((progress: LaunchProgress) => void) | undefined,
          options?.signal
        );
        try {
          return decodeResult(frame, value) as Res<K>;
        } catch (error) {
          if (error instanceof ResultError)
            throw new RunnerCallError(error.error);
          throw error;
        }
      }

      if (
        op === "git.branches" ||
        op === "git.defaultBranch" ||
        op === "git.base"
      ) {
        if (!service.supportsGitQueries?.(placement))
          throw new RunnerCallError({
            code: "unsupported",
            message: `Unsupported operation: ${op}`,
          });
        const query = { op, request: input } as GitQuery;
        const { target } = query.request;
        if ("session" in target && sessionToWire(target.session) !== agent.id)
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid Git query binding.",
          });
        const frame: Decoded<GitQueryName> = {
          op,
          request: query.request,
          absent: [],
          extras: { workspace: placement.workspace, agentId: agent.id },
        };
        try {
          const { value } = await service.requestSession(
            placement,
            { agentId: agent.id, kind: "gitQuery", operation: query },
            undefined,
            options?.signal
          );
          return decodeResult(frame, value) as Res<K>;
        } catch (error) {
          if (error instanceof ResultError)
            throw new RunnerCallError(error.error);
          throw error;
        }
      }

      if (op === "workspace.select") {
        const request = input as Req<"workspace.select">;
        if (sessionToWire(request.session) !== agent.id)
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid checkout command binding.",
          });
        const frame: Decoded<"workspace.select"> = {
          op,
          request,
          extras: { workspace: placement.workspace, agentId: agent.id },
          absent: [],
        };
        const command = encodeCommand(frame);
        if (command.kind !== "sessionCheckout")
          throw new Error("Invalid v1 workspace selection command.");
        const { value } = await service.requestSession(
          placement,
          command,
          undefined,
          options?.signal
        );
        const selected = decodeResult(frame, value);
        if (!operations["workspace.select"].response.check(selected))
          throw new RunnerCallError({
            code: "failed",
            message: "Invalid runner checkout response.",
            details: { status: 502 },
          });
        return selected as Res<K>;
      }

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
    async open<K extends OpenName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<{ info: Res<K>; channel: CallerChannel<K> }> {
      if (op !== "checkout.watch")
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });
      const { target } = input as Req<"checkout.watch">;
      if (!service) throw new Error("The session runner is unavailable.");
      if (
        !placement ||
        !agent ||
        !("session" in target) ||
        sessionToWire(target.session) !== agent.id ||
        (target.checkout ?? "current") !== "current"
      )
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid checkout watch binding.",
        });
      // v1 carries the watch on its own channel, one byte per burst.
      const { channel } = await service.requestSession(
        placement,
        { kind: "watchCheckout", agentId: agent.id },
        undefined,
        options?.signal
      );
      if (!channel)
        throw new RunnerCallError({
          code: "failed",
          message: "Missing runner checkout watch channel.",
        });
      return {
        info: {} as Res<K>,
        channel: watchChannel(channel) as CallerChannel<K>,
      };
    },
  };
}
