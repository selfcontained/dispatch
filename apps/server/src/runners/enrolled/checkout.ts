import { isCheckoutObservation } from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  sessionFromWire,
  pathFromWire,
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
import { sessionFileBlob } from "../../files/session-file-blob.js";
import type { RemoteRunnerService } from "../../agents/remote/service.js";
import type { CheckoutSession } from "../directory.js";

/** References already on a runner session, and those in flight, per service. */
const deliveredReferences = new WeakMap<
  RemoteRunnerService,
  Map<string, Promise<string>>
>();

/**
 * `files.put` and `files.get` through the session's runner. A prompt's file
 * goes under its own name; a listed reference goes under its digest, once
 * per session, so an updated file gets a new path and cannot overwrite an
 * earlier reference or a same-named family file.
 */
async function sessionFile<K extends "files.put" | "files.get">(
  service: RemoteRunnerService,
  runnerId: string,
  agentId: string,
  op: K,
  input: Req<K>
): Promise<Res<K>> {
  if (op === "files.get") {
    const { path } = input as Req<"files.get">;
    const bytes = await service.getFile(runnerId, agentId, path);
    return {
      name: posix.basename(path),
      size: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"),
      blob: bytes.toString("base64"),
    } as Res<K>;
  }
  const { name, blob } = input as Req<"files.put">;
  const file = sessionFileBlob(blob);
  if (file.purpose === "prompt")
    return {
      path: pathFromWire(
        await service.putFile(runnerId, agentId, name, await file.source())
      ),
    } as Res<K>;

  const digest = await file.digest();
  const extension = posix.extname(name).slice(0, 32);
  const storedName = `reference-${digest}${extension}`;
  let delivered = deliveredReferences.get(service);
  if (!delivered) deliveredReferences.set(service, (delivered = new Map()));
  const key = JSON.stringify([runnerId, agentId, storedName]);
  // Share in-flight puts too.
  let delivery = delivered.get(key);
  if (!delivery) {
    const references = delivered;
    delivery = file
      .source(digest)
      .then((source) => service.putFile(runnerId, agentId, storedName, source))
      .catch((error: unknown) => {
        references.delete(key);
        throw error;
      });
    delivered.set(key, delivery);
  }
  return { path: pathFromWire(await delivery) } as Res<K>;
}

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
      if (op === "files.get" || op === "files.put") {
        if (!agent)
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid session file binding.",
          });
        return sessionFile(
          service,
          runnerId,
          agent.id,
          op as "files.put",
          input as Req<"files.put">
        ) as Promise<Res<K>>;
      }
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
      if (op === "workspace.observe" || op === "workspace.release")
        archiveEpoch ??= service.connectionEpoch(runnerId);
      const value = await service.call(
        runnerId,
        op,
        input,
        options,
        op === "workspace.observe" || op === "workspace.release"
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
}
