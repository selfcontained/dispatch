/*
 * Shared value types of the contract. Response shapes are taken from what the
 * existing executors return (local and wire v1), not from the design tables.
 */
import { runnerPath, sessionHandle } from "./opaque.js";
import {
  array,
  boolean,
  integer,
  json,
  literal,
  nullable,
  number,
  object,
  optional,
  record,
  string,
  union,
  type Infer,
} from "./schema.js";

/** Which checkout of a session: the one it works in now, the one it launched in, or the one it moved to. */
export const checkoutSelector = literal("current", "launch", "moved");

/**
 * What an operation reads or acts on: a session's checkout, a path before
 * any session exists, or a repository by URL.
 */
export const target = union(
  object({ session: sessionHandle, checkout: optional(checkoutSelector) }),
  object({ path: runnerPath }),
  object({ repository: string })
);
export type Target = Infer<typeof target>;

/** An environment value: literal text, or a value only the runner knows. */
export const envValue = union(
  string,
  object({
    from: literal("session.id", "session.filesDir", "mcp.origin", "mcp.caFile"),
  })
);

export const mcpServer = object({
  name: string,
  url: string,
  token: string,
  caPem: optional(string),
});

/** Opaque bytes. Wire v1 carries base64 text; other transports resolve it themselves. */
export const blob = {
  shape: { opaque: "Blob" },
  check: (value: unknown): value is string => typeof value === "string",
} as const;

export const build = object({ version: string, revision: optional(string) });

export const maintenanceFailure = object({
  step: string,
  exitCode: integer,
  at: string,
});

/** One instantaneous health sample (wire v1 `RunnerHealth`). */
export const healthSample = object({
  version: string,
  revision: optional(string),
  maintenanceFailure: optional(maintenanceFailure),
  sessions: integer,
  working: integer,
  cpuPercent: nullable(number),
  memoryUsed: number,
  memoryTotal: number,
});

export const hostState = literal("live", "gone", "stale");

/* Terminals (wire v1 terminal types). */
export const terminalInfo = object({ cwd: string, host: string, user: string });
export const terminalControl = union(
  object({ type: literal("input"), data: string }),
  object({ type: literal("resize"), cols: integer, rows: integer }),
  object({ type: literal("detach", "resume") })
);
export const terminalEvent = union(
  object({ type: literal("output"), data: string }),
  object({ type: literal("exit"), code: integer }),
  object({
    type: literal("error"),
    message: string,
    reason: optional(literal("update")),
  })
);

/* Commands. */
export const commandResult = object({
  exitCode: integer,
  stdout: string,
  stderr: string,
  truncated: optional(boolean),
});

/* GitHub. */
export const pullRequest = { owner: string, repo: string, number: integer };
export const githubAccount = union(
  object({
    status: literal("signed-in"),
    login: string,
    gitIdentityUnavailable: optional(literal(true)),
  }),
  object({
    status: literal("pending"),
    code: optional(string),
    verificationUrl: optional(string),
  }),
  object({ status: literal("signed-out") }),
  object({
    status: literal("unavailable", "failed"),
    message: optional(string),
  })
);
export const githubChangedFile = object({
  path: string,
  additions: integer,
  deletions: integer,
  patch: optional(string),
});
export const pullRequestObservation = object({
  state: nullable(literal("OPEN", "CLOSED", "MERGED")),
  draft: boolean,
  title: nullable(string),
  head: nullable(string),
  rollup: nullable(array(json)),
  credentialContext: optional(string),
});
/**
 * A pull request's evidence as the workload account reads it. A platform
 * that scopes reads to a credential names it (`credentialContext`) and pins
 * the base commit (`baseRefOid`); one that does not leaves both out.
 */
export const pullRequestDetails = object({
  credentialContext: optional(string),
  number: integer,
  title: string,
  body: string,
  baseRefName: string,
  headRefName: string,
  baseRefOid: optional(string),
  headRefOid: string,
  additions: integer,
  deletions: integer,
  files: array(githubChangedFile),
});

/* Engines (wire v1 engine-management types). */
export const engineAction = literal(
  "install",
  "update",
  "login",
  "login_cancel"
);
export const engineInventoryEntry = object({
  id: string,
  label: string,
  installed: boolean,
  signedIn: nullable(boolean),
  version: nullable(string),
  detail: optional(string),
  issue: optional(string),
  actions: array(engineAction),
});
export const engineLogin = object({
  id: string,
  engine: string,
  status: literal(
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled"
  ),
  needsCode: boolean,
  url: optional(string),
  userCode: optional(string),
  detail: optional(string),
  error: optional(string),
  expiresAt: optional(string),
  finishedAt: optional(string),
});
export const engineProgress = object({
  type: literal("operation_progress"),
  operationId: string,
  engine: string,
  phase: string,
  message: string,
  outputChunk: optional(string),
});
export const engineComplete = object({
  type: literal("operation_complete"),
  operationId: string,
  engine: string,
  success: boolean,
  message: string,
});
/** Host execution beneath Dispatch's durable update coordinator. */
export const engineUpdateCommand = object({
  executable: string,
  args: array(string),
  env: optional(record(string)),
});
export const engineStatusView = object({
  id: literal("claude", "codex", "opencode"),
  label: string,
  installed: boolean,
  path: nullable(string),
  version: nullable(string),
  install: string,
  update: object({
    realPath: nullable(string),
    probePath: optional(string),
    source: literal(
      "native",
      "npm",
      "homebrew-formula",
      "homebrew-cask",
      "unknown"
    ),
    packageChannel: optional(string),
    migrationWarning: optional(string),
    canUpdate: boolean,
    reason: string,
    command: string,
    latestVersion: nullable(string),
    latestPending: boolean,
    available: boolean,
  }),
});
export const engineInstallation = object({
  status: optional(engineStatusView),
  realPath: nullable(string),
  probePath: optional(string),
  source: literal(
    "native",
    "npm",
    "homebrew-formula",
    "homebrew-cask",
    "unknown"
  ),
  packageChannel: optional(string),
  migrationWarning: optional(string),
  canUpdate: boolean,
  reason: string,
  command: string,
  latestKey: string,
  target: string,
  run: optional(
    object({
      executable: string,
      args: array(string),
      env: optional(record(string)),
      refresh: optional(engineUpdateCommand),
    })
  ),
});
export const engineOperationState = object({
  type: literal("operation_state"),
  operationId: string,
  pid: optional(integer),
  running: boolean,
  output: string,
  outputOffset: integer,
  error: optional(string),
  result: optional(commandResult),
});
export const engineChoice = object({ value: string, name: string });
export const engineModels = object({
  defaultModel: nullable(string),
  models: array(
    object({
      id: string,
      label: string,
      effort: optional(array(engineChoice)),
    })
  ),
});
export const engineUsage = object({
  checkedAt: string,
  providers: array(
    object({
      engine: string,
      plan: nullable(string),
      observedAt: nullable(string),
      source: optional(literal("live", "local")),
      windows: array(
        object({
          id: string,
          label: string,
          usedPercent: number,
          resetsAt: nullable(string),
        })
      ),
      limitReached: optional(boolean),
      spend: optional(
        object({
          used: number,
          limit: number,
          currency: string,
          enabled: optional(boolean),
        })
      ),
      credits: optional(
        object({ balance: nullable(number), unlimited: boolean })
      ),
      limitResets: optional(
        object({ available: integer, applicable: integer })
      ),
      unavailableReason: optional(string),
    })
  ),
  /** Opaque precondition for a quota reset against the reported account. */
  codexResetAccount: optional(string),
});
export const enginePluginStatus = object({
  agentType: optional(literal("claude", "codex")),
  detectionError: optional(string),
  ranCommands: optional(array(string)),
  error: optional(nullable(string)),
  probeFailed: optional(boolean),
  installed: boolean,
  enabled: boolean,
  currentVersion: nullable(string),
  latestVersion: nullable(string),
  updateAvailable: boolean,
  actions: array(literal("install", "update")),
});

/* Updates (wire v1 self-update types). */
export const updateTarget = object({
  version: string,
  os: string,
  arch: string,
  sha256: string,
  revision: string,
});
export const retainedSession = object({
  sessionId: string,
  instanceId: string,
});
export const updateStatus = object({
  attemptId: string,
  phase: literal("deferred", "activating", "confirmed", "rolled_back"),
  reason: optional(string),
  floorVersion: optional(string),
  downloadFailed: optional(literal(true)),
  installed: object({ version: string, revision: string, sha256: string }),
  fenceCleared: optional(literal(true)),
  retained: optional(array(retainedSession)),
  requiresQuiescence: optional(boolean),
});
