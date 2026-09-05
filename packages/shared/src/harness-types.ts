import type { ChatAttachment, ChatQuestionOption } from "./chat-types.js";

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
    /** The tool call's raw input (dsh sends the model's arguments). */
    input?: unknown;
    /** note and think steps: the full text. */
    text?: string;
  };
};

/**
 * A question the agent posted through dispatch_chat_post during the turn:
 * it lives in the Chat feed, which a harness agent's pane does not show,
 * so the Harness view carries it on the turn with its answer state.
 */
export type HarnessQuestion = {
  /** The chat message id; answers post against it. */
  id: string;
  text: string;
  options: ChatQuestionOption[];
  allowFreeform: boolean;
  answer: { value: string; label?: string } | null;
  createdAt: string;
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
  /** Questions the agent asked during this turn, oldest first. */
  questions?: HarnessQuestion[];
};

export type HarnessTurnsResponse = { turns: HarnessTurn[] };

/** A skill the harness can load; the composer's slash menu lists them. */
export type HarnessSkill = {
  name: string;
  description: string;
  /** project: under the working tree; home: the harness home directory. */
  source: "project" | "home";
};

export type HarnessSkillsResponse = { skills: HarnessSkill[] };

/** One selectable value of a session config option. */
export type HarnessConfigChoice = {
  value: string;
  name: string;
  description?: string | null;
};

/** dsh groups model choices by provider route. */
export type HarnessConfigGroup = {
  groupId?: string;
  group?: string;
  name: string;
  options: HarnessConfigChoice[];
};

/**
 * A session config option as the Agent Client Protocol advertises it:
 * dsh serves "model" (grouped by provider) and "reasoning_effort".
 */
export type HarnessConfigOption = {
  id: string;
  name: string;
  category?: string | null;
  type: "select" | (string & {});
  currentValue: string;
  options: (HarnessConfigChoice | HarnessConfigGroup)[];
};

export type HarnessConfigResponse = {
  /** False when the agent has no live session; options are then empty. */
  running: boolean;
  options: HarnessConfigOption[];
};

export type HarnessConfigUpdateRequest = { configId: string; value: string };
