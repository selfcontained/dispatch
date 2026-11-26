import {
  isCheckoutCommandFile,
  isCheckoutObservation,
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
  pathFromWire,
  displayPath,
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
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { sessionFileBlob } from "../../files/session-file-blob.js";
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

/** A read the runner did not answer: its connection, or a peer too old for it. */
function unreachable(error: unknown): never {
  throw new RunnerCallError({
    code: "unavailable",
    message: error instanceof Error ? error.message : "Runner unavailable.",
  });
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
  placement: V1Placement,
  agentId: string,
  op: K,
  input: Req<K>
): Promise<Res<K>> {
  if (op === "files.get") {
    const { path } = input as Req<"files.get">;
    const bytes = await service.getFile(placement, agentId, path);
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
        await service.putFile(placement, agentId, name, await file.source())
      ),
    } as Res<K>;

  const digest = await file.digest();
  const extension = posix.extname(name).slice(0, 32);
  const storedName = `reference-${digest}${extension}`;
  let delivered = deliveredReferences.get(service);
  if (!delivered) deliveredReferences.set(service, (delivered = new Map()));
  const key = JSON.stringify([
    placement.runner,
    placement.workspace,
    agentId,
    storedName,
  ]);
  // Share in-flight puts too.
  let delivery = delivered.get(key);
  if (!delivery) {
    const references = delivered;
    delivery = file
      .source(digest)
      .then((source) => service.putFile(placement, agentId, storedName, source))
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
  placement: V1Placement | null,
  agent: CheckoutSession | undefined,
  describe: () => RunnerDescription,
  legacyView?: CheckoutView
): CheckoutRunner {
  /**
   * The connection this adapter's first observe or release went to. A
   * release is only sent on it: a runner that reconnected after the
   * observation is not released against (as `enrolledArchiveCheckout`).
   */
  let archiveEpoch: number | undefined;
  async function archiveCall<
    K extends "workspace.observe" | "workspace.release",
  >(
    service: RemoteRunnerService,
    placement: V1Placement,
    op: K,
    request: Req<K>,
    signal?: AbortSignal
  ): Promise<Res<K>> {
    archiveEpoch ??= service.connectionEpoch?.(placement.runner);
    const frame = {
      op,
      request,
      absent: [],
      // Bound release observes with changes, or ownership alone for a
      // removal already authorized; the caller decides removal.
      extras: {
        workspace: placement.workspace,
        ...(op === "workspace.observe" && {
          observationPolicy:
            (request as Req<"workspace.observe">).policy ?? "changes",
        }),
      },
    } as Decoded<K>;
    const encoded = encodeCommand(frame);
    if (
      encoded.kind !==
      (op === "workspace.observe" ? "checkoutRelease" : "workspaceRelease")
    )
      throw new Error("Invalid workspace release command.");
    // The bytes the archive transport sends (`enrolledArchiveCheckout`):
    // `requestSession` appends the workspace, so the frame stays identical.
    const command =
      encoded.kind === "checkoutRelease"
        ? {
            kind: encoded.kind,
            agentId: encoded.agentId,
            operation: encoded.operation,
          }
        : encoded;
    const { value } =
      archiveEpoch === undefined
        ? await service.requestSession(placement, command, undefined, signal)
        : await service.requestSession(
            placement,
            command,
            undefined,
            signal,
            archiveEpoch
          );
    let result: Res<K>;
    try {
      result = decodeResult(frame, value);
    } catch (error) {
      if (error instanceof ResultError) throw new RunnerCallError(error.error);
      throw error;
    }
    if (op === "workspace.observe" && !isCheckoutObservation(result))
      throw new RunnerCallError({
        code: "failed",
        message: "Invalid checkout observation from the runner.",
        details: { status: 502 },
      });
    return result;
  }
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
    // Not part of `Runner`: what the peer advertised in its ready frame.
    ...{
      serves(op: "checkout.write" | "workspace.release") {
        if (placement === null || !service) return false;
        // Bound release: the peer carries out the caller's removal decision.
        if (op === "workspace.release")
          return service.supportsWorkspaceRelease?.(placement) === true;
        return service.supportsCheckoutWrite?.(placement) === true;
      },
    },
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op === "runner.describe") return describe() as Res<K>;
      if (
        op === "git.branches" &&
        "repository" in (input as Req<"git.branches">).target
      ) {
        if (!service)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The runner is unavailable.",
          });
        const { target } = input as Req<"git.branches">;
        return service.listRepositoryBranches(
          runnerId,
          target as { repository: string }
        ) as Promise<Res<K>>;
      }
      if (
        op === "git.roots" &&
        !("session" in (input as Req<"git.roots">).target)
      ) {
        if (!service)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The runner is unavailable.",
          });
        return service.readRepositoryRoots(
          runnerId,
          input as Req<"git.roots">
        ) as Promise<Res<K>>;
      }
      if (op === "git.origin") {
        if (!service)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The runner is unavailable.",
          });
        return service.readRepositoryOrigin(
          runnerId,
          input as Req<"git.origin">
        ) as Promise<Res<K>>;
      }
      // A folder on this runner, as its workload account resolves it.
      if (op === "path.resolve") {
        if (!service)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The runner is unavailable.",
          });
        return service.resolveRunnerPath(
          runnerId,
          input as Req<"path.resolve">
        ) as Promise<Res<K>>;
      }
      // A repository's default-branch files before any session exists.
      if (
        op === "checkout.defaultFiles" &&
        "repository" in (input as Req<"checkout.defaultFiles">).target
      ) {
        if (!service)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The runner is unavailable.",
          });
        return service.readRepositoryFiles(
          runnerId,
          input as Req<"checkout.defaultFiles">,
          options?.signal
        ) as Promise<Res<K>>;
      }
      if (op === "checkout.write") {
        const request = input as Req<"checkout.write">;
        if (!service)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The session runner is unavailable.",
          });
        if (
          !placement ||
          !agent ||
          !("session" in request.target) ||
          sessionToWire(request.target.session) !== agent.id
        )
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid checkout write binding.",
          });
        const frame: Decoded<"checkout.write"> = {
          op: "checkout.write",
          request,
          extras: { workspace: placement.workspace, agentId: agent.id },
          absent: [],
        };
        const command = encodeCommand(frame);
        if (command.kind !== "checkoutWrite")
          throw new Error("Invalid v1 checkout write command.");
        const { value } = await service.requestSession(
          placement,
          command,
          undefined,
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
      if (op === "github.pr.head") {
        if (!service) throw new Error("The session runner is unavailable.");
        options?.signal?.throwIfAborted();
        const { owner, repo, number, cwd } = input as Req<"github.pr.head">;
        return service.lookupGitHubPullRequestHead(
          runnerId,
          owner,
          repo,
          number,
          cwd === undefined ? undefined : displayPath(cwd)
        ) as Promise<Res<K>>;
      }
      if (op === "github.pr.status") {
        if (!service) throw new Error("The session runner is unavailable.");
        options?.signal?.throwIfAborted();
        return service.readPullRequestStatus(
          runnerId,
          input as Req<"github.pr.status">
        ) as Promise<Res<K>>;
      }
      if (op === "github.pr.details") {
        if (!service) throw new Error("The session runner is unavailable.");
        options?.signal?.throwIfAborted();
        return service
          .readPullRequestDetails(runnerId, input as Req<"github.pr.details">)
          .catch(unreachable) as Promise<Res<K>>;
      }
      if (op === "github.pr.diff") {
        if (!service) throw new Error("The session runner is unavailable.");
        options?.signal?.throwIfAborted();
        const { base, context, ...rest } = input as Req<"github.pr.diff">;
        // A runner scopes its reads to a credential: a diff names both
        // commits and the credential its details came from.
        if (base === undefined || context === undefined) return null as Res<K>;
        return service
          .readPullRequestDiff(runnerId, { ...rest, base, context })
          .catch(unreachable) as Promise<Res<K>>;
      }
      if (op === "files.put" || op === "files.get") {
        if (!service) throw new Error("The session runner is unavailable.");
        const { session } = input as Req<"files.put" | "files.get">;
        if (!placement || !agent || sessionToWire(session) !== agent.id)
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid session file binding.",
          });
        return sessionFile(
          service,
          placement,
          agent.id,
          op as "files.put",
          input as Req<"files.put">
        ) as Promise<Res<K>>;
      }
      if (op === "workspace.observe" || op === "workspace.release") {
        const { session } = input as Req<"workspace.observe">;
        if (!placement || !agent || sessionToWire(session) !== agent.id)
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid workspace release binding.",
          });
        if (!service || service.supportsWorkspaceRelease?.(placement) !== true)
          throw new RunnerCallError({
            code: "unsupported",
            message: `Unsupported operation: ${op}`,
          });
        return archiveCall(
          service,
          placement,
          op,
          input as Req<"workspace.observe" | "workspace.release">,
          options?.signal
        ) as Promise<Res<K>>;
      }
      if (
        op !== "checkout.exec" &&
        op !== "git.context" &&
        op !== "git.roots" &&
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
        op === "git.roots" ||
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
        const { target } = input as Req<"git.branches">;
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
