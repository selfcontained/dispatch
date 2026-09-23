import type {
  AgentRecord,
  AgentStatus,
  DiffStats as ServerDiffStats,
  FileMedia,
} from "@dispatch/shared";

/**
 * Agent wire types, taken from the shared contract rather than restated so a
 * column added on one side can't be missed. Re-exported from here so the
 * components that already import them from this module keep resolving.
 */
export type { AgentStatus } from "@dispatch/shared";

/**
 * Fields the client treats as optional even though the server always sends
 * them. `AgentRecord` has them as required-nullable, but web builds partial
 * agents in a lot of places (test fixtures, optimistic cache entries), and a
 * component that reads one of these already handles `undefined` the same way
 * it handles `null`.
 */
type LenientAgentField =
  | "type"
  | "role"
  | "setupPhase"
  | "archivePhase"
  | "archiveCleanupMode"
  | "simulatorUdid"
  | "lastError"
  | "activity"
  | "currentTurn"
  | "gitContext"
  | "gitContextStale"
  | "gitContextUpdatedAt"
  | "persona"
  | "parentAgentId"
  | "launchedByAgentId"
  | "personaContext"
  | "reviewAgentType"
  | "baseBranch"
  | "templateId"
  | "autoReview"
  | "cliSessionId";

/**
 * An agent as it arrives over the wire. Both the `snapshot` and
 * `agent.upsert` payloads are `AgentRecord` enriched with `hasStream` by
 * `withStreamFlag` (apps/server/src/server.ts), which is why that field is
 * declared here rather than on the shared `AgentRecord` itself.
 */
export type Agent = Omit<AgentRecord, LenientAgentField> &
  Partial<Pick<AgentRecord, LenientAgentField>> & {
    hasStream?: boolean;
  };

export type FileItem = {
  id: number;
  name: string;
  size: number;
  updatedAt: string;
  url: string;
  seen?: boolean;
  source?: "screenshot" | "stream" | "simulator" | "text" | "user";
  /** Read from the file's bytes when it was stored. */
  mimeType: string;
  /** What the file is to a reader; the Files tab and lightbox switch on it. */
  media: FileMedia;
  description?: string | null;
  /**
   * Stamped client-side, not returned by the API. The selected agent's panel
   * also lists its sub agents' files, so a file has to say whose it is for
   * seen-tracking and the lightbox to address the right agent.
   */
  ownerAgentId?: string;
};

/**
 * A sub agent whose files are grouped under the selected agent. Carries the
 * child's own workspace root so paths resolve against the child's worktree,
 * not the parent's.
 */
export type SubAgentRef = {
  id: string;
  name: string;
  status: AgentStatus;
  workspaceRoot: string | null;
};

export type SubAgentFiles = {
  agent: SubAgentRef;
  files: FileItem[];
  /** The child's files query state, so an unresolved fetch is not shown as "nothing shared". */
  status: "pending" | "error" | "success";
};

export type ConnState = "connected" | "reconnecting" | "disconnected";
export type ServiceState = "ok" | "down" | "checking";
export type AgentVisualState = "stopped" | "idle" | "active";
export type AuthState = "loading" | "needs-login" | "authenticated" | "error";

/**
 * Wire shape of the server's diff stats. Derived from the shared contract
 * rather than restated so a field can't be added on one side and missed — the
 * one divergence is deliberate: `excludingTests` is optional over the wire,
 * because a server that predates it can still be pushing stats over SSE while
 * a newer bundle is loaded, and a badge that falls back to the unfiltered
 * totals beats one that renders NaN.
 */
export type DiffStats = Omit<ServerDiffStats, "excludingTests"> &
  Partial<Pick<ServerDiffStats, "excludingTests">>;
