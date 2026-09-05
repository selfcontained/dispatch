// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
//
// PromptKit's renderer registry is a React context the host fills in.
// Dispatch has one host and one harness, so the registry is a module: the
// step kinds the server emits map to a label and a one-line summary here,
// and to a detail body in step-detail.tsx.
import { diffLines } from "@/components/app/chat/stream-entries";

import type { Step } from "./contracts";

/** What the server puts on a step's `detail` (see harness-types.ts). */
export type StepDetailData = {
  toolKind?: string;
  locations?: { path: string; line?: number }[];
  diff?: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput?: string | null;
  truncated?: boolean;
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

export function kindLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}

export function stepDetailData(step: Step): StepDetailData {
  return (step.detail ?? {}) as StepDetailData;
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The one-line summary after a settled step's label; undefined for none. */
export function stepSummary(step: Step): string | undefined {
  const d = stepDetailData(step);
  switch (step.kind) {
    case "execute":
      return d.terminalOutput?.split("\n").find((l) => l.trim()) ?? undefined;
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
      const n = d.locations?.length ?? 0;
      return n ? `${n} location${n === 1 ? "" : "s"}` : undefined;
    }
    default:
      return undefined;
  }
}
