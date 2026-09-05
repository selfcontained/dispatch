// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import type { ReactNode } from "react";

import { DiffBlock } from "@/components/app/chat/stream-entries";
import { Markdown } from "@/components/ui/markdown";

import type { Step } from "./contracts";
import { stepDetailData, stepSummary } from "./registry";

/** The body under an expanded step, chosen by the step's kind. */
export function StepDetail({ step }: { step: Step }): JSX.Element {
  const summary = stepSummary(step);
  const d = stepDetailData(step);
  return (
    <div className="space-y-2.5 pl-[21px] pt-1 text-foreground/80">
      {summary ? (
        <p className="text-[11px] leading-relaxed">{summary}</p>
      ) : null}
      <DetailBody step={step} />
      {d.truncated ? (
        <p className="text-[11px] text-muted-foreground">
          Output truncated at the server&apos;s size limit.
        </p>
      ) : null}
    </div>
  );
}

function DetailBody({ step }: { step: Step }): JSX.Element | null {
  const d = stepDetailData(step);
  switch (step.kind) {
    case "execute":
      return d.terminalOutput ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-terminal text-[11px] leading-snug">
          {d.terminalOutput}
        </pre>
      ) : null;
    case "edit":
      return d.diff ? (
        <DiffBlock oldText={d.diff.oldText} newText={d.diff.newText} />
      ) : (
        <Locations locations={d.locations} />
      );
    case "read":
    case "search":
      return <Locations locations={d.locations} />;
    case "think":
    case "note":
      return d.text ? (
        <Markdown className="text-[12px]">{d.text}</Markdown>
      ) : null;
    default:
      return <GenericDetail detail={step.detail} />;
  }
}

function Locations({
  locations,
}: {
  locations?: { path: string; line?: number }[];
}): JSX.Element | null {
  if (!locations?.length) return null;
  return (
    <ul className="space-y-0.5 font-terminal text-[11px] text-muted-foreground">
      {locations.map((l, i) => (
        <li key={`${l.path}:${l.line ?? ""}:${i}`} className="truncate">
          {l.path}
          {l.line ? `:${l.line}` : ""}
        </li>
      ))}
    </ul>
  );
}

function GenericDetail({ detail }: { detail: unknown }): JSX.Element | null {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return null;
  }
  const rows: [string, ReactNode][] = [];
  for (const [key, value] of Object.entries(
    detail as Record<string, unknown>
  )) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    rows.push([key, String(value)]);
  }
  if (rows.length === 0) return null;
  return <KvGrid rows={rows} />;
}

function KvGrid({ rows }: { rows: [string, ReactNode][] }): JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {k}
          </dt>
          <dd className="text-[11px] text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
