// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
//
// PromptKit's renderer registry is a React context the host fills in.
// Dispatch has one host and one harness, so the registry is a module: the
// step kinds the server emits map to a label, a one-line summary and a
// "has anything to expand" check here, and to a detail body in
// step-detail.tsx.
import { diffLines } from "@/components/app/chat/stream-entries";

import type { Step } from "./contracts";

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

/** The row's label: the tool's own name, or the kind when there is none. */
export function stepLabel(step: Step): string {
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

/** Whether expanding the step would show anything at all. */
export function hasDetail(step: Step): boolean {
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
