import type { RunnerEngine } from "./execution.js";

/** The last contiguous position durably received in the named host journal. */
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
