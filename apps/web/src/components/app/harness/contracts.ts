// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
//
// The turn and trace data model, trimmed to what the Harness view renders:
// PromptKit's Brane-specific pieces (forms, artifacts, reflection, feedback,
// clarification, the transport port) are left out.

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
  finalResult?: "ok" | "error" | "clarification";
  extra?: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  status: "applied" | "noop" | "error";
  message?: string;
}

export interface ToolCallRecord {
  call: ToolCall;
  outcome?: ToolOutcome;
}

export interface Attachment {
  kind: string;
  url: string;
  name?: string;
  mimeType?: string;
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
  toolCalls?: ToolCallRecord[];
  trace?: Trace;
  error?: TurnError;
  timestamp: number;
  extra?: Record<string, unknown>;
}

/** Live events folded into a trace by the reducer. */
export type StreamEvent =
  | {
      type: "step";
      kind: string;
      id?: string;
      attempt?: number;
      label?: string;
    }
  | {
      type: "step_update";
      kind: string;
      id?: string;
      attempt?: number;
      status: "ok" | "retry" | "error";
      durMs?: number;
      reason?: string;
      detail?: unknown;
    }
  | { type: "delta"; text: string }
  | { type: "tool_call"; call: ToolCall; outcome?: ToolOutcome }
  | { type: "result"; content: string }
  | { type: "error"; error: TurnError }
  | { type: "done" };
