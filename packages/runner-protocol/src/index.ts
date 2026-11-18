export type Placement = { runner: string; workspace: string };

/** Wire identities are case-sensitive and are not paths. */
export function isOpaqueId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(value)
  ) {
    return false;
  }
  try {
    // Reject lone UTF-16 surrogates, which have no UTF-8 representation.
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/** Split first and decode each component exactly once. URL parsers can normalize IDs. */
export function remotePlacement(cwd: string): Placement | null {
  const match = /^runner:\/\/([\w.!~*'()%+-]+)\/([\w.!~*'()%+-]+)$/.exec(cwd);
  if (!match || match[0] !== cwd) return null;
  try {
    const runner = decodeURIComponent(match[1]!);
    const workspace = decodeURIComponent(match[2]!);
    return isOpaqueId(runner) && isOpaqueId(workspace)
      ? { runner, workspace }
      : null;
  } catch {
    return null;
  }
}

export function workspaceLocator({ runner, workspace }: Placement): string {
  if (!isOpaqueId(runner) || !isOpaqueId(workspace)) {
    throw new Error("Invalid runner or workspace ID");
  }
  return `runner://${encodeURIComponent(runner)}/${encodeURIComponent(workspace)}`;
}

export const RUNNER_WIRE_VERSION = 1;

export type RunnerEngine = "claude" | "codex" | "opencode";

export type ServiceMcp = {
  url: string;
  token: string;
  /** Legacy launchers omit the name and use "dispatch". */
  name?: string;
};

/** The guest supplies all machine-local execution settings. */
export type RemoteLaunch = {
  agentId: string;
  engine: RunnerEngine;
  fullAccess?: boolean;
  model: string | null;
  effort?: string | null;
  systemPrompt: string | null;
  personaContext?: string | null;
  mcp?: ServiceMcp;
  resumeSessionId: string | null;
};

export type Command = { agentId: string; workspace: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "attach" | "alive" | "discard" | "log" | "repo" }
  | { kind: "stop"; force: boolean }
);
export type Frame =
  | { type: "ready"; version: typeof RUNNER_WIRE_VERSION; workspaces: string[] }
  | { type: "request"; id: string; command: Command }
  | {
      type: "result";
      id: string;
      value?: boolean | string;
      error?: string;
      code?: "host-gone";
    }
  | { type: "data"; id: string; data: string }
  | { type: "close"; id: string };

/** The last durably applied position in the named host journal. */
export type ReplayHello = {
  type: "hello";
  fromSeq: number;
  journalId?: string | null;
  replayComplete?: boolean;
};

export type HostWelcome = {
  type: "welcome";
  agentId: string;
  engine: RunnerEngine;
  sessionId: string;
  resumed: boolean;
  running: boolean;
  journalSeq: number;
  journalId?: string;
};

export type JournalEntry<Event> = {
  seq: number;
  at: string;
  event: Event;
  /** Absent on entries written by older hosts. */
  journalId?: string;
};

export type HostEvent<Event = unknown> = {
  type: "event";
} & JournalEntry<Event>;
export type ReplayComplete = { type: "replay_complete" };

export type HostPrompt<Source = unknown, Image = unknown> = {
  type: "prompt";
  id: string;
  text: string;
  journalId?: string;
  source?: Source;
  images?: Image[];
};

export type PromptReceipt =
  | { type: "prompt_accepted"; id: string }
  /** An engine-initiated turn is open and the host did not submit this prompt. */
  | { type: "prompt_deferred"; id: string };
