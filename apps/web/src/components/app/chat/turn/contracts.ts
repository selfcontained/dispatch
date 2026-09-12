// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
//
// The turn and trace data model, trimmed to what a turn entry renders.
// PromptKit's Brane-specific pieces (forms, artifacts, reflection, feedback,
// clarification, the transport port) and its stream-event reducer are left
// out: the server assembles settled turns, so nothing folds events here.

export type StepStatus = "running" | "ok" | "error";

/** One unit of work inside a turn's trace. `kind` is open: the registry maps it. */
export interface Step {
  id: string;
  kind: string;
  label?: string;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
  durMs?: number;
  detail?: unknown;
  /** Steps run under this one: a subagent's work, nested one level in the rail. */
  children?: Step[];
}

/** The activity behind one assistant turn. */
export interface Trace {
  startedAt: number;
  endedAt?: number;
  steps: Step[];
  finalResult?: "ok" | "error" | "interrupted";
}

export interface TurnError {
  code: string;
  message: string;
}

/** One message in the stream, from the user or the assistant. */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  trace?: Trace;
  error?: TurnError;
  timestamp: number;
  extra?: Record<string, unknown>;
}
