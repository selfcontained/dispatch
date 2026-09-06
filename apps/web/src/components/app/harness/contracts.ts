// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
//
// The turn and trace data model, trimmed to what the Harness view renders.
// PromptKit's Brane-specific pieces (forms, artifacts, reflection, feedback,
// clarification, the transport port) and its stream-event reducer are left
// out: the server assembles settled turns, so nothing folds events here.

/** Step outcome. `retry` and `skipped` are kept for parity with PromptKit. */
export type StepStatus = "running" | "ok" | "retry" | "error" | "skipped";

/** One unit of work inside a turn's trace. `kind` is open: the registry maps it. */
export interface Step {
  id: string;
  kind: string;
  label?: string;
  attempt?: number;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
  durMs?: number;
  reason?: string;
  detail?: unknown;
}

/** The activity behind one assistant turn. */
export interface Trace {
  startedAt: number;
  endedAt?: number;
  steps: Step[];
  finalResult?: "ok" | "error" | "interrupted" | "clarification";
  extra?: Record<string, unknown>;
}

export interface Attachment {
  kind: string;
  url: string;
  name?: string;
  mimeType?: string;
  /** Bytes, when known (feeds the media lightbox). */
  size?: number;
  /** When the message carrying it was sent (ISO). */
  at?: string;
}

export interface ContextChip {
  label: string;
  payload?: unknown;
}

export interface TurnError {
  code: string;
  message: string;
  hint?: string;
}

/** One message in the stream, from the user or the assistant. */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  contextChips?: ContextChip[];
  trace?: Trace;
  error?: TurnError;
  timestamp: number;
  extra?: Record<string, unknown>;
}
