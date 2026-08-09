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

export const AGENT_INITIAL_PROMPT_MAX_CHARS = 16_000;
export const CODEX_FULL_ACCESS_ARG =
  "--dangerously-bypass-approvals-and-sandbox";
export const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export type AgentRouteDeps = {
  pool: Pool;
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
