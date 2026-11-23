/*
 * Wire v1 behind the contract. Maps each v1 command, result and update frame
 * to a contract operation and back, without changing a byte of what v1 peers
 * send or accept.
 *
 * What v1 cannot carry is explicit:
 * - `IMPLIED`: contract fields a v1 runner derives itself. Decoding fills the
 *   value it uses; encoding drops the field (the v1 runner ignores a caller's
 *   value).
 * - `EXTRAS`: v1-only fields with no contract field. Decoding moves them into
 *   `extras`; encoding restores them. Each names the task that deletes it.
 * - `absent`: optional v1 fields that were missing, so encoding omits them
 *   again rather than writing the default.
 * - `LEGACY`: v1 commands with no operation, passed through unchanged.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  checkoutCommandTimeoutMs,
  type CheckoutCommand,
  type CheckoutView,
  type Command,
  type CheckoutQuery,
  type GitHubOperation,
  type RemoteLaunch,
  type ResultFrame,
  type UpdateServiceFrame,
  type UpdateStatusFrame,
} from "@dispatch/runner-protocol";
import type {
  EngineOperation,
  EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";
import type {
  ErrorCode,
  OpName,
  Req,
  Res,
  RunnerError,
} from "@dispatch/runner-protocol/contract";

type AnyRecord = Record<string, unknown>;

export type Decoded<K extends OpName = OpName> = {
  op: K;
  request: Req<K>;
  /** v1-only fields, restored on encode. */
  extras: AnyRecord;
  /** Optional v1 fields that were missing. */
  absent: string[];
};

export type LegacyCommand = { op: null; legacy: string; command: Command };

/** v1 commands with no contract operation, and the task that removes each. */
export const LEGACY = {
  repo: "T14: the fixed repo command is deleted",
  "inspectCheckout.listFiles":
    "T09: folds into checkout.list (names only, no entry kinds)",
  "inspectCheckout.roots": "T09/T15: folds into git.context",
  "github.watchPullRequests": "T33: Dispatch's refresher polls instead",
} as const;

/** Contract fields a v1 runner derives itself, by operation. */
export const IMPLIED = {
  "session.launch": {
    overflowNotice: "T24: the v1 host composes the overflow text itself",
    env: "T24: the v1 supervisor builds the session environment",
    owner: "v1 has no owner",
  },
  "session.logs": { lines: "the v1 tail is fixed at 20 lines" },
  "terminal.open": { cols: "v1 starts at 80", rows: "v1 starts at 24" },
  "checkout.read": {
    encoding: "v1 reads UTF-8",
    maxBytes: "v1 bounds at its decoder",
  },
  "checkout.stats": { exclude: "T09: v1 excludes its own test-file rule" },
  "checkout.diff": { exclude: "T09: v1 marks its own test-file rule" },
  "checkout.exec": {
    env: "T14: the v1 executor builds the environment",
    timeoutMs: "T14: v1 derives it from the checkout selector",
    maxOutput: "T14: v1 applies its own limit",
    shell: "T14: v1 runs a login shell",
  },
  "files.put": {
    size: "derived from the bytes",
    digest: "derived from the bytes",
  },
  "engine.list": { refresh: "v1 always probes" },
  "engine.quota.reset": { engine: "v1 resets only Codex" },
} as const satisfies Partial<Record<OpName, AnyRecord>>;

/** v1-only fields carried in `extras`, by v1 command kind. */
export const EXTRAS = {
  workspace: "T40: workspaces are deleted (D7)",
  repository: "T19: workspace.prepare from a repository, inside v1 launch",
  useWorktreeOf: "T18: workspace.prepare borrowing a session, inside v1 launch",
  prepareWorkspace: "T18: workspace preparation opt-in, inside v1 launch",
  checkoutCommand: "T14: v1 reads tool manifests through the command family",
  withCredentialContext: "T32: credential context is always returned",
  refreshWatch: "T33: watch refresh is removed with the watch",
  agentId: "v1 runner-wide commands carry an ignored agent id",
  expectedState: "T20: the runner's state recheck is deleted (N35)",
  v1Result: "T20: retained and inUse feed the offline and pending release path",
} as const;

export class CodecError extends Error {}

const sha256 = (base64: string) =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
const byteLength = (base64: string) => Buffer.from(base64, "base64").length;

function v1Selector(checkout: CheckoutCommand["checkout"]) {
  return checkout === "effective" ? "current" : checkout;
}
function contractSelector(
  checkout: "current" | "launch" | "moved" | undefined
) {
  if (!checkout) throw new CodecError("v1 commands need a checkout selector.");
  return checkout === "current" ? "effective" : checkout;
}

function sessionOf(request: AnyRecord): string {
  const target = (request.target ?? request) as AnyRecord;
  if (typeof target.session !== "string")
    throw new CodecError("v1 can only address a session's checkout.");
  return target.session;
}

function decoded<K extends OpName>(
  op: K,
  request: AnyRecord,
  extras: AnyRecord = {},
  absent: string[] = []
): Decoded<K> {
  return { op, request: request as Req<K>, extras, absent };
}

function decodeLaunch(command: Command & { kind: "launch" }, frameId: string) {
  const launch = command.launch;
  const absent: string[] = (
    ["fullAccess", "effort", "personaContext", "mcp", "launchId"] as const
  ).filter((field) => launch[field] === undefined);
  if (launch.mcp && launch.mcp.name === undefined) absent.push("mcp.name");
  const extras: AnyRecord = {};
  for (const field of [
    "repository",
    "useWorktreeOf",
    "prepareWorkspace",
  ] as const)
    if (launch[field] !== undefined) extras[field] = launch[field];
  if (launch.agentId !== command.agentId)
    throw new CodecError("v1 launch names two sessions.");
  return decoded(
    "session.launch",
    {
      session: command.agentId,
      launchId: launch.launchId ?? frameId,
      engine: launch.engine,
      model: launch.model,
      effort: launch.effort ?? null,
      access: launch.fullAccess === false ? "default" : "full",
      resume: launch.resumeSessionId,
      systemText: launch.systemPrompt,
      firstText: launch.personaContext ?? null,
      overflowNotice: null,
      env: {},
      mcp: launch.mcp
        ? [
            {
              // The v1 default when a legacy launcher omits the name.
              name: launch.mcp.name ?? "dispatch",
              url: launch.mcp.url,
              token: launch.mcp.token,
            },
          ]
        : [],
      owner: null,
    },
    extras,
    absent
  );
}

function encodeLaunch(
  request: Req<"session.launch">,
  extras: AnyRecord,
  absent: string[]
): RemoteLaunch {
  if (request.mcp.length > 1)
    throw new CodecError("v1 carries one MCP server.");
  const keep = (field: string) => !absent.includes(field);
  const [mcp] = request.mcp;
  const session = request.session as unknown as string;
  return {
    agentId: session,
    engine: request.engine as RemoteLaunch["engine"],
    ...(keep("fullAccess") && { fullAccess: request.access === "full" }),
    model: request.model,
    ...(keep("effort") && { effort: request.effort }),
    systemPrompt: request.systemText,
    ...(keep("personaContext") && { personaContext: request.firstText }),
    ...(mcp && {
      mcp: {
        url: mcp.url,
        token: mcp.token,
        ...(keep("mcp.name") && { name: mcp.name }),
      },
    }),
    resumeSessionId: request.resume,
    ...(extras.repository !== undefined && {
      repository: extras.repository as RemoteLaunch["repository"],
    }),
    ...(extras.useWorktreeOf !== undefined && {
      useWorktreeOf: extras.useWorktreeOf as string,
    }),
    ...(extras.prepareWorkspace !== undefined && {
      prepareWorkspace: true as const,
    }),
    ...(keep("launchId") && { launchId: request.launchId }),
  };
}

function decodeView(session: string, view: CheckoutView): Decoded {
  const target = { session };
  switch (view.kind) {
    case "directory":
      return decoded("checkout.list", { target, path: view.path });
    case "preview":
      return decoded("checkout.preview", { target, path: view.path });
    case "index":
      return decoded("checkout.index", { target, generation: view.generation });
    case "stats":
      return decoded("checkout.stats", {
        target,
        base: view.baseBranch,
        uncommitted: view.includeUncommitted,
        exclude: [],
      });
    case "diff":
    case "fileDiff":
      return decoded("checkout.diff", {
        target,
        base: view.baseBranch,
        uncommitted: view.includeUncommitted,
        whitespace: view.ignoreWhitespace ? "ignore" : "show",
        exclude: [],
        ...(view.kind === "fileDiff" && { path: view.path }),
      });
    case "image":
      return decoded("checkout.image", {
        target,
        base: view.baseBranch,
        uncommitted: view.includeUncommitted,
        path: view.path,
        side: view.side,
      });
  }
}

function encodeView(op: OpName, r: AnyRecord): CheckoutView {
  const diff = {
    baseBranch: r.base as string | null,
    includeUncommitted: r.uncommitted as boolean,
  };
  switch (op) {
    case "checkout.list":
      return { kind: "directory", path: r.path as string };
    case "checkout.preview":
      return { kind: "preview", path: r.path as string };
    case "checkout.index":
      return { kind: "index", generation: r.generation as string };
    case "checkout.stats":
      return { ...diff, kind: "stats" };
    case "checkout.diff":
      return r.path === undefined
        ? { ...diff, kind: "diff", ignoreWhitespace: r.whitespace === "ignore" }
        : {
            ...diff,
            kind: "fileDiff",
            path: r.path as string,
            ignoreWhitespace: r.whitespace === "ignore",
          };
    case "checkout.image":
      return {
        ...diff,
        kind: "image",
        path: r.path as string,
        side: r.side as "old" | "new",
      };
    default:
      throw new CodecError(`${op} is not a v1 view.`);
  }
}

function decodeInspect(
  session: string,
  query: CheckoutQuery,
  command: Command
): Decoded | LegacyCommand {
  const target = { session };
  switch (query.kind) {
    case "changes":
      return decoded("checkout.changes", { target, base: query.baseBranch });
    case "readFile":
      return decoded("checkout.read", {
        target,
        path: query.path,
        encoding: "utf8",
        maxBytes: null,
      });
    case "defaultBranchFiles":
      return decoded("checkout.defaultFiles", {
        target,
        dirs: query.directories,
        wait: query.waitForRefresh,
      });
    case "listFiles":
    case "roots":
      return { op: null, legacy: `inspectCheckout.${query.kind}`, command };
  }
}

const ENGINE_OPS = {
  status: "engine.list",
  install: "engine.install",
  update: "engine.update",
  login_start: "engine.login.start",
  login_submit: "engine.login.submit",
  login_status: "engine.login.status",
  login_cancel: "engine.login.cancel",
  model_catalog: "engine.models",
  provider_usage: "engine.usage",
  codex_reset: "engine.quota.reset",
  plugin_status: "engine.plugin.status",
  plugin_install: "engine.plugin.apply",
  plugin_update: "engine.plugin.apply",
} as const satisfies Record<EngineOperation["type"], OpName>;

function decodeEngine(o: EngineOperation, frameId: string): Decoded {
  const op = ENGINE_OPS[o.type];
  switch (o.type) {
    case "status":
      return decoded(op, { refresh: true });
    case "install":
    case "update":
      return decoded(op, { engine: o.engine, requestId: frameId });
    case "login_start":
      return decoded(
        op,
        { engine: o.engine, restart: o.restart ?? false, requestId: frameId },
        {},
        o.restart === undefined ? ["restart"] : []
      );
    case "login_submit":
      return decoded(op, { loginId: o.loginId, code: o.code });
    case "login_status":
    case "login_cancel":
      return decoded(op, { loginId: o.loginId });
    case "model_catalog":
      return decoded(op, {
        engine: o.engine,
        ...(o.model !== undefined && { model: o.model }),
      });
    case "provider_usage":
      return decoded(op, {});
    case "codex_reset":
      return decoded(op, {
        engine: "codex",
        account: o.account,
        requestId: o.requestId,
      });
    case "plugin_status":
      return decoded(op, { engine: o.engine, plugin: o.plugin });
    case "plugin_install":
    case "plugin_update":
      return decoded(op, {
        engine: o.engine,
        plugin: o.plugin,
        action: o.type === "plugin_install" ? "install" : "update",
        requestId: frameId,
      });
  }
}

function encodeEngine(
  op: OpName,
  r: AnyRecord,
  absent: string[]
): EngineOperation {
  const engine = r.engine as never;
  switch (op) {
    case "engine.list":
      return { type: "status" };
    case "engine.install":
      return { type: "install", engine };
    case "engine.update":
      return { type: "update", engine };
    case "engine.login.start":
      return {
        type: "login_start",
        engine,
        ...(!absent.includes("restart") && { restart: r.restart as boolean }),
      };
    case "engine.login.submit":
      return {
        type: "login_submit",
        loginId: r.loginId as string,
        code: r.code as string,
      };
    case "engine.login.status":
      return { type: "login_status", loginId: r.loginId as string };
    case "engine.login.cancel":
      return { type: "login_cancel", loginId: r.loginId as string };
    case "engine.models":
      return {
        type: "model_catalog",
        engine,
        ...(r.model !== undefined && { model: r.model as string }),
      };
    case "engine.usage":
      return { type: "provider_usage" };
    case "engine.quota.reset":
      if (r.engine !== "codex")
        throw new CodecError("v1 resets only Codex quotas.");
      return {
        type: "codex_reset",
        account: r.account as string,
        requestId: r.requestId as string,
      };
    case "engine.plugin.status":
      return { type: "plugin_status", engine, plugin: r.plugin as string };
    case "engine.plugin.apply":
      return {
        type: r.action === "install" ? "plugin_install" : "plugin_update",
        engine,
        plugin: r.plugin as string,
      };
    default:
      throw new CodecError(`${op} is not a v1 engine operation.`);
  }
}

function decodeGitHub(
  o: GitHubOperation,
  frameId: string,
  command: Command
): Decoded | LegacyCommand {
  const pr = (o: { owner: string; repo: string; number: number }) => ({
    owner: o.owner,
    repo: o.repo,
    number: o.number,
  });
  switch (o.type) {
    case "status":
      return decoded("github.account", {});
    case "login":
      return decoded("github.login.start", { requestId: frameId });
    case "cancel":
      return decoded("github.login.cancel", { requestId: frameId });
    case "logout":
      return decoded("github.logout", {});
    case "repositorySearch":
      return decoded("github.repositories", { query: o.query });
    case "repositoryBranches":
      return decoded("github.branches", { owner: o.owner, repo: o.repo });
    case "pullRequestHead":
      return decoded("github.pr.head", pr(o));
    case "pullRequestDetails":
      return decoded("github.pr.details", pr(o));
    case "pullRequestStatus": {
      const extras: AnyRecord = {};
      if (o.withCredentialContext) extras.withCredentialContext = true;
      if (o.refreshWatch) extras.refreshWatch = true;
      return decoded("github.pr.status", pr(o), extras);
    }
    case "pullRequestDiff":
      return decoded("github.pr.diff", {
        ...pr(o),
        base: o.base,
        head: o.head,
        context: o.credentialContext,
      });
    case "watchPullRequests":
      return { op: null, legacy: "github.watchPullRequests", command };
  }
}

function encodeGitHub(
  op: OpName,
  r: AnyRecord,
  extras: AnyRecord
): GitHubOperation {
  const pr = {
    owner: r.owner as string,
    repo: r.repo as string,
    number: r.number as number,
  };
  switch (op) {
    case "github.account":
      return { type: "status" };
    case "github.login.start":
      return { type: "login" };
    case "github.login.cancel":
      return { type: "cancel" };
    case "github.logout":
      return { type: "logout" };
    case "github.repositories":
      return { type: "repositorySearch", query: r.query as string };
    case "github.branches":
      return { type: "repositoryBranches", owner: pr.owner, repo: pr.repo };
    case "github.pr.head":
      return { type: "pullRequestHead", ...pr };
    case "github.pr.details":
      return { type: "pullRequestDetails", ...pr };
    case "github.pr.status":
      return {
        type: "pullRequestStatus",
        ...pr,
        ...(extras.withCredentialContext === true && {
          withCredentialContext: true,
        }),
        ...(extras.refreshWatch === true && { refreshWatch: true }),
      };
    case "github.pr.diff":
      return {
        type: "pullRequestDiff",
        ...pr,
        base: r.base as string,
        head: r.head as string,
        credentialContext: r.context as string,
      };
    default:
      throw new CodecError(`${op} is not a v1 GitHub operation.`);
  }
}

/** A v1 request command as a contract operation. `frameId` keys idempotent operations v1 does not key. */
export function decodeCommand(
  command: Command,
  frameId: string
): Decoded | LegacyCommand {
  const withWorkspace = (d: Decoded | LegacyCommand) => {
    if (d.op !== null) d.extras.workspace = command.workspace;
    return d;
  };
  const runnerWide = (d: Decoded | LegacyCommand) => {
    if (d.op !== null) d.extras.agentId = command.agentId;
    return withWorkspace(d);
  };
  const session = command.agentId;
  switch (command.kind) {
    case "launch":
      return withWorkspace(decodeLaunch(command, frameId));
    case "attach":
      return withWorkspace(decoded("session.attach", { session }));
    case "alive":
      return withWorkspace(decoded("session.alive", { session }));
    case "discard":
      return withWorkspace(decoded("session.discard", { session }));
    case "stop":
      return withWorkspace(
        decoded("session.stop", { session, force: command.force })
      );
    case "log":
      return withWorkspace(decoded("session.logs", { session, lines: 20 }));
    case "openTerminal":
      return withWorkspace(
        decoded("terminal.open", { target: { session }, cols: 80, rows: 24 })
      );
    case "watchCheckout":
      return withWorkspace(decoded("checkout.watch", { target: { session } }));
    case "checkoutRead":
      return { op: null, legacy: "checkoutRead", command };
    case "viewCheckout":
      return withWorkspace(decodeView(session, command.query));
    case "inspectCheckout":
      return withWorkspace(decodeInspect(session, command.query, command));
    case "sessionCheckout":
      return withWorkspace(
        command.operation.kind === "describe"
          ? decoded("workspace.describe", { session })
          : decoded("workspace.select", {
              session,
              path: command.operation.path,
            })
      );
    case "checkoutRelease":
      return withWorkspace(
        command.operation.kind === "observe"
          ? decoded("workspace.observe", { session })
          : // v1 runners decide branch deletion themselves; these are placeholders.
            decoded(
              "workspace.release",
              { session, deleteBranch: false, originalBranch: null },
              { expectedState: command.operation.expectedState }
            )
      );
    case "checkoutCommand": {
      const o = command.operation;
      const target = { session, checkout: v1Selector(o.checkout) };
      if (o.kind === "read")
        return withWorkspace(
          decoded(
            "checkout.read",
            { target, path: o.path, encoding: "utf8", maxBytes: null },
            { checkoutCommand: true }
          )
        );
      return withWorkspace(
        decoded("checkout.exec", {
          target,
          guard: { path: o.path, digest: o.state },
          argv: o.argv,
          env: o.execution?.env ?? {},
          timeoutMs: o.execution
            ? o.execution.timeoutMs
            : checkoutCommandTimeoutMs(o.checkout),
          maxOutput: o.execution?.maxOutput ?? null,
          shell: o.execution?.shell ?? "login",
        })
      );
    }
    case "sessionFile": {
      const o = command.operation;
      return withWorkspace(
        o.kind === "deliver"
          ? decoded("files.put", {
              session,
              name: o.name,
              size: byteLength(o.data),
              digest: sha256(o.data),
              blob: o.data,
            })
          : decoded("files.get", { session, path: o.path })
      );
    }
    case "engine":
      return runnerWide(decodeEngine(command.operation, frameId));
    case "github":
      return runnerWide(decodeGitHub(command.operation, frameId, command));
    case "repo":
      return { op: null, legacy: "repo", command };
  }
}

/** A contract operation as the v1 request command a v1 runner accepts. */
export function encodeCommand(input: Decoded | LegacyCommand): Command {
  if (input.op === null) return input.command;
  const { op, extras, absent } = input;
  const r = input.request as AnyRecord;
  const workspace = extras.workspace;
  if (typeof workspace !== "string")
    throw new CodecError("v1 commands need a workspace.");
  const base = (agentId: string) => ({ workspace, agentId });
  if (op.startsWith("engine."))
    return {
      ...base(extras.agentId as string),
      kind: "engine",
      operation: encodeEngine(op, r, absent),
    };
  if (op.startsWith("github."))
    return {
      ...base(extras.agentId as string),
      kind: "github",
      operation: encodeGitHub(op, r, extras),
    };
  const agentId = sessionOf(r);
  const session = base(agentId);
  switch (op) {
    case "session.launch":
      return {
        ...session,
        kind: "launch",
        launch: encodeLaunch(r as Req<"session.launch">, extras, absent),
      };
    case "session.attach":
      return { ...session, kind: "attach" };
    case "session.alive":
      return { ...session, kind: "alive" };
    case "session.discard":
      return { ...session, kind: "discard" };
    case "session.stop":
      return { ...session, kind: "stop", force: r.force as boolean };
    case "session.logs":
      return { ...session, kind: "log" };
    case "terminal.open":
      return { ...session, kind: "openTerminal" };
    case "checkout.watch":
      return { ...session, kind: "watchCheckout" };
    case "workspace.describe":
      return {
        ...session,
        kind: "sessionCheckout",
        operation: { kind: "describe" },
      };
    case "workspace.select":
      return {
        ...session,
        kind: "sessionCheckout",
        operation: { kind: "select", path: r.path as string | null },
      };
    case "workspace.observe":
      return {
        ...session,
        kind: "checkoutRelease",
        operation: { kind: "observe" },
      };
    case "workspace.release":
      // Until T20 the adapter supplies the state of the observation it just made.
      if (extras.expectedState === undefined)
        throw new CodecError("v1 release needs extras.expectedState.");
      return {
        ...session,
        kind: "checkoutRelease",
        operation: {
          kind: "release",
          expectedState: extras.expectedState as string | null,
        },
      };
    case "checkout.changes":
      return {
        ...session,
        kind: "inspectCheckout",
        query: { kind: "changes", baseBranch: r.base as string | null },
      };
    case "checkout.defaultFiles":
      return {
        ...session,
        kind: "inspectCheckout",
        query: {
          kind: "defaultBranchFiles",
          directories: r.dirs as string[],
          waitForRefresh: r.wait as boolean,
        },
      };
    case "checkout.read": {
      const target = r.target as { checkout?: "current" | "launch" | "moved" };
      if (extras.checkoutCommand)
        return {
          ...session,
          kind: "checkoutCommand",
          operation: {
            kind: "read",
            checkout: contractSelector(target.checkout),
            path: r.path as string,
          },
        };
      return {
        ...session,
        kind: "inspectCheckout",
        query: { kind: "readFile", path: r.path as string },
      };
    }
    case "checkout.exec": {
      const target = r.target as { checkout?: "current" | "launch" | "moved" };
      const guard = r.guard as { path: string; digest: string };
      return {
        ...session,
        kind: "checkoutCommand",
        operation: {
          checkout: contractSelector(target.checkout),
          path: guard.path,
          kind: "run",
          state: guard.digest,
          argv: r.argv as string[],
        },
      };
    }
    case "files.put":
      return {
        ...session,
        kind: "sessionFile",
        operation: {
          kind: "deliver",
          name: r.name as string,
          data: r.blob as string,
        },
      };
    case "files.get":
      return {
        ...session,
        kind: "sessionFile",
        operation: { kind: "collect", path: r.path as string },
      };
    case "checkout.list":
      if (r.filesOnly === true)
        return {
          ...session,
          kind: "inspectCheckout",
          query: { kind: "listFiles", path: r.path as string },
        };
      return { ...session, kind: "viewCheckout", query: encodeView(op, r) };
    case "checkout.preview":
    case "checkout.index":
    case "checkout.stats":
    case "checkout.diff":
    case "checkout.image":
      return { ...session, kind: "viewCheckout", query: encodeView(op, r) };
    default:
      throw new CodecError(`${op} has no v1 command.`);
  }
}

/* Results */

/** v1 result frame error as a contract error. */
export function decodeError(frame: ResultFrame): RunnerError | null {
  if (frame.error === undefined && frame.code === undefined) return null;
  const message = frame.error ?? "";
  if (frame.code === "host-gone") return { code: "host_gone", message };
  if (frame.code === "update-fenced") return { code: "fenced", message };
  return { code: "failed", message };
}

/** A contract error as v1 result frame fields. v1 has no codes beyond these two. */
export function encodeError(
  error: RunnerError
): Pick<ResultFrame, "error" | "code"> {
  if (error.code === "host_gone")
    return { code: "host-gone", error: error.message };
  if (error.code === "fenced")
    return { code: "update-fenced", error: error.message };
  return { error: error.message };
}

/** View workers report failures with these statuses inside a successful v1 result. */
const VIEW_STATUS: Record<number, ErrorCode> = {
  400: "invalid",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  500: "failed",
};
const STATUS_OF = Object.fromEntries(
  Object.entries(VIEW_STATUS).map(([status, code]) => [code, Number(status)])
) as Partial<Record<ErrorCode, number>>;

export class ResultError extends Error {
  constructor(readonly error: RunnerError) {
    super(error.message);
  }
}

function ackError(ack: Extract<EngineOperationAck, { ok: false }>): never {
  throw new ResultError({
    code: ack.unsupported
      ? "unsupported"
      : ack.reason === "account_changed"
        ? "stale"
        : "failed",
    message: ack.error,
  });
}

type Value = ResultFrame["value"];
const parse = (value: Value) => {
  if (typeof value !== "string")
    throw new CodecError("Expected a v1 JSON result.");
  return JSON.parse(value) as AnyRecord;
};
function stripKind({ kind: _, ...rest }: AnyRecord) {
  return rest;
}

/**
 * A v1 result value as the contract response. `events` are the data lines a
 * v1 runner sent on the request before its result (engine inventory).
 * Throws `ResultError` for failures v1 reports inside a successful result.
 */
export function decodeResult<K extends OpName>(
  input: Decoded<K>,
  value: Value,
  events: unknown[] = []
): Res<K> {
  const { op } = input;
  const r = input.request as AnyRecord;
  const out = (response: unknown) => response as Res<K>;
  switch (op) {
    case "session.launch":
    case "session.attach":
    case "session.stop":
    case "session.discard":
    case "checkout.watch":
      return out({});
    case "session.alive":
      return out({ state: value === true ? "live" : "gone" });
    case "session.logs":
      return out({ text: value as string });
    case "terminal.open":
      return out(parse(value));
    case "workspace.describe":
    case "workspace.select":
    case "workspace.observe":
      return out(parse(value));
    case "workspace.release":
      input.extras.v1Result = value;
      return out({ removed: value === "released" });
    case "files.put":
      return out({ path: value });
    case "files.get": {
      const blob = value as string;
      return out({
        name: posix.basename(r.path as string),
        size: byteLength(blob),
        digest: sha256(blob),
        blob,
      });
    }
    case "checkout.exec":
      return out(parse(value));
    case "checkout.read": {
      if (input.extras.checkoutCommand) {
        const file = parse(value) as { content: string; state: string } | null;
        return out(file && { data: file.content, digest: file.state });
      }
      const { content } = parse(value) as { content: string | null };
      return out(content === null ? null : { data: content });
    }
    case "checkout.changes":
    case "checkout.defaultFiles":
      return out(stripKind(parse(value)));
    case "checkout.list":
    case "checkout.preview":
    case "checkout.index":
    case "checkout.stats":
    case "checkout.diff":
    case "checkout.image": {
      const reply = parse(value);
      if ("status" in reply && "error" in reply && !("data" in reply))
        throw new ResultError({
          code: VIEW_STATUS[reply.status as number] ?? "failed",
          message: reply.error as string,
        });
      const data = reply.data as AnyRecord | string | null;
      if (op === "checkout.image") return out({ bytes: data });
      if (op === "checkout.stats" && data && typeof data === "object") {
        const { excludingTests, ...rest } = data;
        return out({ ...rest, excluded: excludingTests });
      }
      if (
        op === "checkout.diff" &&
        r.path === undefined &&
        data &&
        typeof data === "object"
      )
        return out({
          ...data,
          files: (data.files as AnyRecord[]).map(({ isTest, ...file }) => ({
            ...file,
            excluded: isTest,
          })),
        });
      return out(data);
    }
  }
  if (op.startsWith("github.")) return out(parse(value));
  if (op.startsWith("engine.")) {
    const ack = parse(value) as EngineOperationAck;
    if (!ack.ok) ackError(ack);
    switch (op) {
      case "engine.list": {
        const inventory = events.find(
          (event) => (event as AnyRecord)?.type === "inventory"
        ) as { entries: unknown[] } | undefined;
        return out({ entries: inventory?.entries ?? [] });
      }
      case "engine.install":
      case "engine.update":
        return out({
          operationId: ack.operationId,
          ...(ack.message !== undefined && { message: ack.message }),
        });
      case "engine.login.start":
      case "engine.login.submit":
      case "engine.login.status":
      case "engine.login.cancel":
        return out(ack.login);
    }
    const capability = ack.capability as AnyRecord | undefined;
    if (!capability) throw new CodecError("Missing v1 engine capability.");
    switch (capability.type) {
      case "model_catalog":
        return out(capability.catalog);
      case "provider_usage":
        return out(capability.usage);
      case "codex_reset":
        return out({
          code: capability.code,
          windowsReset: capability.windowsReset,
        });
      case "plugin_status":
        return out(capability.status);
    }
  }
  throw new CodecError(`${op} has no v1 result.`);
}

/** A contract response (or failure) as the v1 result value a v1 runner sends. */
export function encodeResult<K extends OpName>(
  input: Decoded<K>,
  response: Res<K> | ResultError
): Value {
  const { op } = input;
  const r = input.request as AnyRecord;
  if (response instanceof ResultError) {
    const { code, message } = response.error;
    if (op.startsWith("checkout.") && STATUS_OF[code] !== undefined)
      return JSON.stringify({ status: STATUS_OF[code], error: message });
    if (op.startsWith("engine."))
      return JSON.stringify({
        ok: false,
        ...(code === "unsupported" && { unsupported: true }),
        ...(code === "stale" && { reason: "account_changed" }),
        error: message,
      });
    throw new CodecError(`v1 reports ${op} failures as error frames.`);
  }
  const res = response as AnyRecord;
  switch (op) {
    case "session.launch":
    case "session.attach":
    case "session.stop":
    case "session.discard":
    case "checkout.watch":
      return true;
    case "session.alive":
      return res.state === "live";
    case "session.logs":
      return res.text as string;
    case "workspace.release":
      return (input.extras.v1Result ??
        (res.removed ? "released" : "retained")) as string;
    case "files.put":
      return res.path as string;
    case "files.get":
      return res.blob as string;
    case "checkout.read":
      if (input.extras.checkoutCommand)
        return JSON.stringify(
          response === null ? null : { content: res.data, state: res.digest }
        );
      return JSON.stringify({
        kind: "readFile",
        content: response === null ? null : res.data,
      });
    case "checkout.changes":
      return JSON.stringify({ kind: "changes", ...res });
    case "checkout.defaultFiles":
      return JSON.stringify({ kind: "defaultBranchFiles", ...res });
    case "checkout.image":
      return JSON.stringify({ data: res.bytes });
    case "checkout.stats": {
      if (response === null) return JSON.stringify({ data: null });
      const { excluded, outcome, computedAt, ...totals } = res;
      return JSON.stringify({
        data: {
          ...totals,
          excludingTests: excluded,
          computedAt,
          ...(outcome !== undefined && { outcome }),
        },
      });
    }
    case "checkout.diff":
      if (r.path === undefined && response !== null)
        return JSON.stringify({
          data: {
            ...res,
            files: (res.files as AnyRecord[]).map(
              ({ excluded, truncated, image, ...file }) => ({
                ...file,
                truncated,
                isTest: excluded,
                ...(image !== undefined && { image }),
              })
            ),
          },
        });
      return JSON.stringify({ data: response });
    case "checkout.list":
    case "checkout.preview":
    case "checkout.index":
      return JSON.stringify({ data: response });
  }
  if (op.startsWith("engine.")) {
    switch (op) {
      case "engine.list":
        return JSON.stringify({ ok: true });
      case "engine.install":
      case "engine.update":
        return JSON.stringify({ ok: true, ...res });
      case "engine.login.start":
      case "engine.login.submit":
      case "engine.login.status":
      case "engine.login.cancel":
        return JSON.stringify({ ok: true, login: response });
      case "engine.models":
        return JSON.stringify({
          ok: true,
          capability: { type: "model_catalog", catalog: response },
        });
      case "engine.usage":
        return JSON.stringify({
          ok: true,
          capability: { type: "provider_usage", usage: response },
        });
      case "engine.quota.reset":
        return JSON.stringify({
          ok: true,
          capability: { type: "codex_reset", ...res },
        });
      default:
        return JSON.stringify({
          ok: true,
          capability: { type: "plugin_status", status: response },
        });
    }
  }
  return JSON.stringify(response);
}

/* Update frames */

const UPDATE_OPS = {
  update_offer: "update.offer",
  update_fence: "update.fence",
  update_activate: "update.activate",
  update_confirm: "update.confirm",
  update_cancel: "update.cancel",
} as const;

export function decodeUpdateFrame(frame: UpdateServiceFrame): Decoded {
  const op = UPDATE_OPS[frame.type];
  switch (frame.type) {
    case "update_offer":
      return decoded(op, {
        attempt: frame.attemptId,
        target: frame.target,
        retry: frame.retry,
      });
    case "update_fence":
      return decoded(op, {
        attempt: frame.attemptId,
        retained: frame.retainSessions,
      });
    case "update_activate":
      return decoded(op, { attempt: frame.attemptId });
    case "update_confirm":
      return decoded(op, {
        attempt: frame.attemptId,
        revision: frame.revision,
        sha256: frame.sha256,
      });
    case "update_cancel":
      return decoded(op, { attempt: frame.attemptId, reason: frame.reason });
  }
}

export function encodeUpdateFrame({
  op,
  request,
}: Decoded): UpdateServiceFrame {
  const r = request as AnyRecord;
  const attemptId = r.attempt as string;
  switch (op) {
    case "update.offer":
      return {
        type: "update_offer",
        attemptId,
        target: r.target as never,
        retry: r.retry as boolean,
      };
    case "update.fence":
      return {
        type: "update_fence",
        attemptId,
        retainSessions: r.retained as boolean,
      };
    case "update.activate":
      return { type: "update_activate", attemptId };
    case "update.confirm":
      return {
        type: "update_confirm",
        attemptId,
        revision: r.revision as string,
        sha256: r.sha256 as string,
      };
    case "update.cancel":
      return { type: "update_cancel", attemptId, reason: r.reason as never };
    default:
      throw new CodecError(`${op} is not a v1 update frame.`);
  }
}

/** An update status frame as the contract's status response. */
export function decodeUpdateStatus({
  type: _,
  ...status
}: UpdateStatusFrame): Res<"update.offer"> {
  return status as Res<"update.offer">;
}
export function encodeUpdateStatus(
  status: Res<"update.offer">
): UpdateStatusFrame {
  return { type: "update_status", ...status } as UpdateStatusFrame;
}

/** Contract operations with no v1 command, frame or result. */
export const NOT_ON_V1 = {
  "runner.describe": "derived from the v1 ready frame plus registry fields",
  "runner.health": "v1 pushes health frames after accept_health",
  "session.list": "local-only today (listHosted, inspectHost)",
  "session.sample": "local-only today (process-tree sampling)",
  "workspace.prepare": "carried inside v1 launch (see EXTRAS)",
  "workspace.resume": "local-only today",
  "path.resolve": "controller-machine probe today (D7)",
  "path.complete": "controller-machine probe today (D7)",
  "checkout.write": "local-only today (persona authoring)",
  "git.context": "local probe today; v1 roots and sessionCheckout carry parts",
  "git.defaultBranch": "local-only today",
  "git.branches": "local-only today; v1 has github.branches",
  "git.base": "decided inside Dispatch today",
  "engine.operation": "no lookup by operation ID on either side",
  "port.connect": "missing from both (D6)",
} as const satisfies Partial<Record<OpName, string>>;
