// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
//
// PromptKit's renderer registry is a React context the host fills in.
// Dispatch has one host and one harness, so the registry is a module: the
// step kinds the server emits map to a label, a one-line summary and a
// "has anything to expand" check here, and to a detail body in
// step-detail.tsx.
import { diffLines } from "@/components/app/chat/stream-entries";

import type { Step, Trace, Turn } from "./contracts";

/** What the server puts on a step's `detail` (see harness-types.ts). */
export type StepDetailData = {
  toolKind?: string;
  locations?: { path: string; line?: number }[];
  diff?: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput?: string | null;
  truncated?: boolean;
  /** The tool call's raw input; dsh sends the model's arguments. */
  input?: unknown;
  text?: string;
  /** A `subagent` step: the child session it started. */
  subagentSessionId?: string;
};

const LABELS: Record<string, string> = {
  execute: "run",
  edit: "edit",
  read: "read",
  search: "search",
  fetch: "fetch",
  think: "thinking",
  note: "",
};

const SUMMARY_MAX = 96;

export function kindLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}

export function stepDetailData(step: Step): StepDetailData {
  return (step.detail ?? {}) as StepDetailData;
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** `mcp__dispatch__dispatch_event` → { name: "dispatch_event", server: "dispatch" }. */
export function toolName(title: string): { name: string; server?: string } {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title);
  return m ? { name: m[2], server: m[1] } : { name: title };
}

/** The tool's own name, lowercased, without its MCP server prefix. */
export function stepToolName(step: Step): string {
  const title = step.label?.trim();
  return title ? toolName(title).name.toLowerCase() : "";
}

/** dsh's `subagent` tool: the step stands for a whole child session. */
export function isSubagentStep(step: Step): boolean {
  return stepToolName(step) === "subagent";
}

/** dsh's `todo_write` tool: the step carries the agent's task list. */
export function isTodoStep(step: Step): boolean {
  return stepToolName(step) === "todo_write";
}

export type TodoItem = {
  content: string;
  /** pending | in_progress | completed */
  status: string;
};

/**
 * The task list as the agent last wrote it: from the live turn while one
 * runs, else from the last settled turn; empty when neither has one.
 */
export function latestTodoItems(
  turns: Turn[],
  liveTrace: Trace | null,
  streaming: boolean
): TodoItem[] {
  let steps: Step[] = [];
  if (streaming && liveTrace) steps = liveTrace.steps;
  else {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const trace = turns[i].trace;
      if (turns[i].role === "assistant" && trace) {
        steps = trace.steps;
        break;
      }
    }
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (isTodoStep(steps[i])) return todoItems(steps[i]);
  }
  return [];
}

/** The task list a todo step wrote, when it is one. */
export function todoItems(step: Step): TodoItem[] {
  const input = inputRecord(stepDetailData(step).input);
  const todos = input?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((t) => {
    const record = inputRecord(t);
    return record && typeof record.content === "string"
      ? [
          {
            content: record.content,
            status:
              typeof record.status === "string" ? record.status : "pending",
          },
        ]
      : [];
  });
}

/** The child session a subagent step started; the server reads it off dsh's output. */
export function subagentSessionId(step: Step): string | null {
  const id = stepDetailData(step).subagentSessionId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Labels of the shortcut pins a turn's dispatch_pin / dispatch_pins calls
 * wrote, in call order. The live pin list decides what to show for them.
 */
export function shortcutLabelsFromSteps(steps: Step[]): string[] {
  const labels: string[] = [];
  const push = (pin: unknown) => {
    const record = inputRecord(pin);
    if (!record || typeof record.label !== "string") return;
    // An update without a type keeps the pin's stored type; the caller
    // filters against the live list, so keep those too.
    if (record.type !== undefined && record.type !== "shortcut") return;
    if (!labels.includes(record.label)) labels.push(record.label);
  };
  for (const step of steps) {
    const name = stepToolName(step);
    const input = inputRecord(stepDetailData(step).input);
    if (!input) continue;
    if (name === "dispatch_pin") push(input);
    else if (name === "dispatch_pins" && Array.isArray(input.pins)) {
      for (const pin of input.pins) push(pin);
    }
  }
  return labels;
}

/** The row's label: the tool's own name, or the kind when there is none. */
export function stepLabel(step: Step): string {
  if (isTodoStep(step)) return "tasks";
  const title = step.label?.trim();
  if (!title) return kindLabel(step.kind);
  return toolName(title).name.toLowerCase();
}

/** The tool's input as a record, when it is one. */
export function inputRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function clip(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function primitiveEntries(record: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(record)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    out.push([k, String(v)]);
  }
  return out;
}

/** A one-line "k: v · k: v" digest of a tool's primitive arguments. */
export function argsSummary(input: unknown): string | undefined {
  const record = inputRecord(input);
  if (!record) return undefined;
  const parts = primitiveEntries(record).map(
    ([k, v]) => `${k}: ${clip(v, 40)}`
  );
  return parts.length ? clip(parts.join(" · ")) : undefined;
}

/** The one-line summary after a settled step's label; undefined for none. */
export function stepSummary(step: Step): string | undefined {
  const d = stepDetailData(step);
  const input = inputRecord(d.input);
  if (isSubagentStep(step)) {
    const description = input?.description;
    return typeof description === "string" ? clip(description) : undefined;
  }
  if (isTodoStep(step)) {
    const items = todoItems(step);
    if (items.length === 0) return undefined;
    const done = items.filter((i) => i.status === "completed").length;
    const active = items.find((i) => i.status === "in_progress");
    const progress = `${done} of ${items.length} done`;
    return active ? clip(`${progress} · ${active.content}`) : progress;
  }
  switch (step.kind) {
    case "execute": {
      const command = input?.command ?? input?.cmd;
      return typeof command === "string" ? clip(command) : undefined;
    }
    case "edit": {
      if (!d.diff) {
        return d.locations?.[0] ? basename(d.locations[0].path) : undefined;
      }
      const lines = diffLines(d.diff.oldText, d.diff.newText);
      const add = lines.filter((l) => l.kind === "add").length;
      const del = lines.filter((l) => l.kind === "del").length;
      return `${basename(d.diff.path)} +${add} −${del}`;
    }
    case "read": {
      const loc = d.locations?.[0];
      if (!loc) return undefined;
      return `${basename(loc.path)}${loc.line ? `:${loc.line}` : ""}`;
    }
    case "search": {
      const pattern = input?.pattern ?? input?.query ?? input?.regex;
      if (typeof pattern === "string") return clip(pattern);
      const n = d.locations?.length ?? 0;
      return n ? `${n} location${n === 1 ? "" : "s"}` : undefined;
    }
    case "fetch": {
      const url = input?.url;
      return typeof url === "string" ? clip(url) : undefined;
    }
    case "think":
    case "note":
      return undefined;
    default:
      return argsSummary(d.input);
  }
}

/** dsh's read tool wraps its output as <path>…</path><type>…</type><content>…</content>. */
export function unwrapReadOutput(output: string): string {
  const m = /<content>\n?([\s\S]*?)(?:<\/content>\s*)?$/.exec(output);
  return m ? m[1] : output;
}

/**
 * A short account of a turn from its steps, for a turn the agent did not
 * describe itself: the most consequential kind wins, with a count or the
 * one file or command it touched.
 */
export function turnLabelFromSteps(steps: Step[]): string | undefined {
  const of = (kind: string) => steps.filter((s) => s.kind === kind);
  const files = (list: Step[]) => {
    const names = new Set<string>();
    for (const s of list) {
      const d = stepDetailData(s);
      const path = d.diff?.path ?? d.locations?.[0]?.path;
      if (path) names.add(basename(path));
    }
    return [...names];
  };
  const edits = of("edit");
  if (edits.length) {
    const names = files(edits);
    return names.length === 1
      ? `edited ${names[0]}`
      : `edited ${names.length || edits.length} files`;
  }
  const runs = of("execute");
  if (runs.length) {
    if (runs.length === 1) {
      const input = inputRecord(stepDetailData(runs[0]).input);
      const command = input?.command ?? input?.cmd;
      if (typeof command === "string") return `ran ${clip(command, 40)}`;
    }
    return `ran ${runs.length} command${runs.length === 1 ? "" : "s"}`;
  }
  const reads = of("read");
  const searches = of("search");
  if (reads.length || searches.length) {
    const names = files(reads);
    if (reads.length === 1 && names.length === 1) return `read ${names[0]}`;
    if (reads.length) return `read ${names.length || reads.length} files`;
    return `searched ${searches.length === 1 ? "once" : `${searches.length} times`}`;
  }
  const fetches = of("fetch");
  if (fetches.length)
    return `fetched ${fetches.length} page${fetches.length === 1 ? "" : "s"}`;
  const tools = steps.filter(
    (s) => !["think", "note"].includes(s.kind) && s.label
  );
  if (tools.length === 1) return toolName(tools[0].label ?? "").name;
  if (tools.length > 1) return `${tools.length} tool calls`;
  if (steps.some((s) => s.kind === "think")) return "thought it over";
  return undefined;
}

/** Whether expanding the step would show anything at all. */
export function hasDetail(step: Step): boolean {
  if (isSubagentStep(step)) return true;
  if (isTodoStep(step)) return todoItems(step).length > 0;
  const d = stepDetailData(step);
  const output = !!d.terminalOutput?.trim();
  const locations = (d.locations?.length ?? 0) > 0;
  switch (step.kind) {
    case "execute":
      return output;
    case "edit":
      return !!d.diff || locations;
    case "read":
    case "search":
    case "fetch":
      return output || locations;
    case "think":
    case "note":
      return !!d.text?.trim();
    default: {
      const record = inputRecord(d.input);
      return output || (!!record && Object.keys(record).length > 0);
    }
  }
}

/** dsh's goal loop, as its goal tools last reported it. */
export type GoalState = {
  id: string;
  objective: string;
  phase: string;
  roundsStarted: number;
  maxRounds: number;
  blockedReason?: string;
};

const GOAL_TOOLS = new Set(["create_goal", "update_goal", "get_goal"]);

/** The goal in a goal tool's output, when the output is one. */
export function goalFromStep(step: Step): GoalState | null {
  if (!GOAL_TOOLS.has(stepToolName(step))) return null;
  const output = stepDetailData(step).terminalOutput;
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as { goal?: Record<string, unknown> };
    const goal = parsed.goal;
    if (!goal || typeof goal.objective !== "string") return null;
    const blocked = inputRecord(goal.blockedReason);
    return {
      id: typeof goal.id === "string" ? goal.id : "",
      objective: goal.objective,
      phase: typeof goal.phase === "string" ? goal.phase : "active",
      roundsStarted:
        typeof goal.roundsStarted === "number" ? goal.roundsStarted : 0,
      maxRounds:
        typeof goal.maxGoalRounds === "number" ? goal.maxGoalRounds : 0,
      ...(typeof blocked?.message === "string"
        ? { blockedReason: blocked.message }
        : typeof goal.blockedReason === "string"
          ? { blockedReason: goal.blockedReason }
          : {}),
    };
  } catch {
    return null;
  }
}

/** The newest goal state across the turns and the live trace. */
export function latestGoal(
  turns: Turn[],
  liveTrace: Trace | null
): GoalState | null {
  const traces: Trace[] = [];
  for (const turn of turns) if (turn.trace) traces.push(turn.trace);
  if (liveTrace) traces.push(liveTrace);
  for (let t = traces.length - 1; t >= 0; t -= 1) {
    const steps = traces[t].steps;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const goal = goalFromStep(steps[i]);
      if (goal) return goal;
    }
  }
  return null;
}
