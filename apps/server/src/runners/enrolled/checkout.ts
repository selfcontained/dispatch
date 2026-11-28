import { isCheckoutObservation } from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  sessionFromWire,
  pathFromWire,
  sessionToWire,
  type Runner,
  type CallName,
  type CallOptions,
  type OpenName,
  type Req,
  type Res,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import { projectRepositoryUrl } from "../../agents/remote/repository.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { withSessionFiles } from "@dispatch/runner-client/session-files";
import type { RemoteRunnerService } from "../../agents/remote/service.js";
import type { CheckoutSession } from "../directory.js";

export function createEnrolledCheckoutRunner(
  service: RemoteRunnerService | undefined,
  runnerId: string,
  agent: CheckoutSession | undefined,
  describe: () => RunnerDescription
): Runner {
  /**
   * The connection this adapter's first observe or release went to. A
   * release is only sent on it: a runner that reconnected after the
   * observation is not released against.
   */
  let archiveEpoch: number | undefined;
  const runner: Runner = {
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
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op === "runner.describe") return describe() as Res<K>;
      if (!service)
        throw new RunnerCallError({
          code: "unavailable",
          message: "The session runner is unavailable.",
        });
      const targeted = "target" in input ? input.target : input;
      if (
        targeted &&
        typeof targeted === "object" &&
        "session" in targeted &&
        (!agent || targeted.session !== sessionFromWire(agent.id))
      )
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid checkout binding.",
        });
      if (
        (op === "checkout.defaultFiles" || op === "git.branches") &&
        targeted &&
        typeof targeted === "object" &&
        "repository" in targeted &&
        typeof targeted.repository === "string"
      ) {
        try {
          input = {
            ...input,
            target: { repository: projectRepositoryUrl(targeted.repository) },
          };
        } catch {
          throw new RunnerCallError({
            code: "invalid",
            message: "Not a runner repository URL.",
          });
        }
      }
      if (
        op === "workspace.observe" ||
        op === "workspace.release" ||
        op === "session.retire"
      )
        archiveEpoch ??= service.connectionEpoch(runnerId);
      const value = await service.call(
        runnerId,
        op,
        input,
        options,
        op === "workspace.observe" ||
          op === "workspace.release" ||
          op === "session.retire"
          ? archiveEpoch
          : undefined
      );
      if (op === "workspace.observe" && !isCheckoutObservation(value))
        throw new RunnerCallError({
          code: "failed",
          message: "Invalid checkout observation from the runner.",
          details: { status: 502 },
        });
      return value;
    },
    async open<K extends OpenName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ) {
      if (!service)
        throw new RunnerCallError({
          code: "unavailable",
          message: "The session runner is unavailable.",
        });
      return service.open(runnerId, op, input, options?.signal);
    },
  };
  if (!service) return runner;
  return withSessionFiles(runner, agent?.id, {
    copyReferences: true,
    scope: service,
    namespace: runnerId,
    async upload(input, file, digest) {
      return {
        path: pathFromWire(
          await service.putFile(
            runnerId,
            sessionToWire(input.session),
            input.name,
            await file.source(digest)
          )
        ),
      };
    },
    async download(input, signal) {
      const bytes = await service.getFile(
        runnerId,
        sessionToWire(input.session),
        input.path,
        signal
      );
      return {
        bytes,
        name: posix.basename(input.path),
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  });
}
