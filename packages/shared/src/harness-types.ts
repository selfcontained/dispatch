import type { ChatAttachment } from "./chat-types.js";

/**
 * The Harness view's wire types: a stream-driven agent's activity cut into
 * turns. Assembled server-side from `agent_stream_events`; the web maps
 * them onto the PromptKit turn model it renders.
 */

export type HarnessPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  /** Cross-agent messages: who sent it. */
  senderName?: string;
  chatMessageId?: string;
  attachments: ChatAttachment[];
};

export type HarnessStepStatus = "running" | "ok" | "error";

export type HarnessStep = {
  id: string;
  /** execute | edit | read | search | fetch | think | note | other */
  kind: string;
  label: string;
  status: HarnessStepStatus;
  startedAt: string;
  endedAt?: string;
  durMs?: number;
  detail: {
    toolKind?: string;
    locations?: { path: string; line?: number }[];
    diff?: { path: string; oldText: string | null; newText: string } | null;
    terminalOutput?: string | null;
    truncated?: boolean;
    /** note and think steps: the full text. */
    text?: string;
  };
};

export type HarnessTurn = {
  id: string;
  prompt: HarnessPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error";
    steps: HarnessStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
};

export type HarnessTurnsResponse = { turns: HarnessTurn[] };
