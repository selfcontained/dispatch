import type {
  HarnessConfigOption,
  HarnessUsageResponse,
} from "@dispatch/shared";
import type { QueuedPrompt } from "../../agents/dsh/supervisor.js";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type WebSocket from "ws";

import type { AgentManager, AgentRecord } from "../../agents/manager.js";
import type { DiffStatsRefresher } from "../../agents/diff-stats-refresher.js";
import type {
  CopyModeObserverManager,
  TerminalUiState,
} from "../../terminal/copy-mode-observer.js";
import type { CopyModeAssistManager } from "../../terminal/copy-mode-assist-manager.js";
import type { InjectionCoordinator } from "../../terminal/injection-coordinator.js";
import type { ChatService } from "../../chat/service.js";

export const AGENT_INITIAL_PROMPT_MAX_CHARS = 16_000;
export const CODEX_FULL_ACCESS_ARG =
  "--dangerously-bypass-approvals-and-sandbox";
export const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export type AgentRouteDeps = {
  pool: Pool;
  /** The harness home (DSH_HOME); its skills dir feeds the slash menu. */
  dshHome: string;
  /** Session config (model, effort) for Dispatch Harness agents. */
  harness: {
    getConfigOptions: (agentId: string) => HarnessConfigOption[] | null;
    setConfigOption: (
      agentId: string,
      configId: string,
      value: string
    ) => Promise<HarnessConfigOption[]>;
    /** Prompts waiting behind the running turn (DshSupervisor.listQueued). */
    listQueued: (agentId: string) => QueuedPrompt[];
    /** Promote and interrupt; false when nothing queued has that id. */
    sendQueuedNow: (agentId: string, id: string) => Promise<boolean>;
    removeQueued: (agentId: string, id: string) => boolean;
    /** What the provider keys have been used for (see agents/dsh/usage.ts). */
    usage: () => Promise<HarnessUsageResponse>;
  };
  appLog: FastifyBaseLogger;
  agentManager: AgentManager;
  publishUiEvent: (event: unknown) => void;
  subscribeUiEvents: (stream: NodeJS.WritableStream) => () => void;
  sendUiSnapshot: (
    stream: NodeJS.WritableStream,
    agents: Array<AgentRecord & { hasStream: boolean }>
  ) => void;
  ackWebNotification: (notificationId: string) => boolean;
  clearFocusedAgents: () => void;
  setFocusedAgent: (agentId: string) => void;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
  startStream: (agentId: string, port: number) => Promise<void>;
  stopStream: (agentId: string, description: string | null) => void;
  hasStream: (agentId: string) => boolean;
  addStreamViewer: (
    agentId: string,
    stream: NodeJS.WritableStream
  ) => () => void;
  issueTerminalToken: (agentId: string) => string;
  consumeTerminalToken: (agentId: string, token: string) => boolean;
  copyModeObserverManager: CopyModeObserverManager;
  copyModeAssistManager: CopyModeAssistManager;
  injectionCoordinator: InjectionCoordinator;
  diffStatsRefresher: DiffStatsRefresher;
  onArchivedAgentsDeleted: (deletedIds: string[]) => void;
  onArchiveError: (agentId: string, error: unknown) => void;
  trackArchivePromise: (agentId: string, archivePromise: Promise<void>) => void;
  sendAgentPrompt: (agentId: string, prompt: string) => Promise<void>;
  onAgentStarted: (agentId: string) => Promise<void>;
  /**
   * Delivers a user-fired prompt (quick phrase, shortcut pin) as a Chat
   * message when the Chat surface is on — see `chat/user-prompt.ts`.
   */
  chat: ChatService;
  /** Read per click: the flag is a cold path and must not be cached stale. */
  isChatSurfaceEnabled: () => Promise<boolean>;
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function decodeClientMessage(
  buffer: WebSocket.RawData
):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interaction"; interaction: "scroll" }
  | null {
  try {
    const asString = typeof buffer === "string" ? buffer : buffer.toString();
    const parsed = JSON.parse(asString) as {
      type?: unknown;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
      interaction?: unknown;
    };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return { type: "input", data: parsed.data };
    }
    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number"
    ) {
      return {
        type: "resize",
        cols: parsed.cols,
        rows: parsed.rows,
      };
    }
    if (parsed.type === "interaction" && parsed.interaction === "scroll") {
      return { type: "interaction", interaction: parsed.interaction };
    }
    return null;
  } catch {
    return null;
  }
}
