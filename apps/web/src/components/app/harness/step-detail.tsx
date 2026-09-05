// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import type { ReactNode } from "react";

import { DiffBlock } from "@/components/app/chat/stream-entries";
import { Markdown } from "@/components/ui/markdown";

import {
  CodeBlock,
  JsonBlock,
  looksLikePathList,
  OutputBlock,
  parseReadOutput,
  PathList,
} from "./code-block";
import type { Step } from "./contracts";
import { inputRecord, stepDetailData } from "./registry";

/** The body under an expanded step, chosen by the step's kind. */
export function StepDetail({ step }: { step: Step }): JSX.Element {
  const d = stepDetailData(step);
  return (
    <div className="space-y-2.5 pl-[21px] pt-1 text-foreground/80">
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
  const input = inputRecord(d.input);
  switch (step.kind) {
    case "execute": {
      const command = input?.command ?? input?.cmd;
      return (
        <>
          {typeof command === "string" ? (
            <CommandLine command={command} />
          ) : null}
          <OutputBlock text={d.terminalOutput} />
        </>
      );
    }
    case "edit":
      return d.diff ? (
        <DiffBlock oldText={d.diff.oldText} newText={d.diff.newText} />
      ) : (
        <Locations locations={d.locations} />
      );
    case "read": {
      if (!d.terminalOutput?.trim()) {
        return <Locations locations={d.locations} />;
      }
      const parsed = parseReadOutput(d.terminalOutput);
      const fileName = parsed.path ?? d.locations?.[0]?.path;
      return (
        <>
          <Locations locations={d.locations} />
          {parsed.type === "directory" || looksLikePathList(parsed.code) ? (
            <PathList text={parsed.code} />
          ) : (
            <CodeBlock
              code={parsed.code}
              fileName={fileName}
              startLine={parsed.startLine}
              lineNumbers={parsed.startLine !== undefined}
            />
          )}
          {parsed.note ? (
            <p className="text-[10.5px] text-muted-foreground">{parsed.note}</p>
          ) : null}
        </>
      );
    }
    case "search":
    case "fetch":
      return (
        <>
          <Locations locations={d.locations} />
          {d.terminalOutput && looksLikePathList(d.terminalOutput) ? (
            <PathList text={d.terminalOutput} />
          ) : (
            <OutputBlock text={d.terminalOutput} />
          )}
        </>
      );
    case "think":
    case "note":
      return d.text ? (
        <Markdown className="text-[12px]">{d.text}</Markdown>
      ) : null;
    default:
      return (
        <>
          <Args input={d.input} />
          <OutputBlock text={d.terminalOutput} />
        </>
      );
  }
}

function CommandLine({ command }: { command: string }): JSX.Element {
  return (
    <p className="whitespace-pre-wrap font-terminal text-[11px] text-foreground">
      <span className="select-none text-muted-foreground">$ </span>
      {command}
    </p>
  );
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

/** A tool's arguments: primitives as a grid, nested values as JSON. */
function Args({ input }: { input: unknown }): JSX.Element | null {
  const record = inputRecord(input);
  if (!record) return null;
  const rows: [string, ReactNode][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    rows.push([
      key,
      typeof value === "object" ? (
        <JsonBlock value={value} maxHeight="max-h-40" />
      ) : typeof value === "string" && value.includes("\n") ? (
        <pre className="whitespace-pre-wrap rounded-md bg-background/60 p-2 font-terminal text-[11px] leading-[1.5]">
          {value}
        </pre>
      ) : (
        String(value)
      ),
    ]);
  }
  if (rows.length === 0) return null;
  return <KvGrid rows={rows} />;
}

function KvGrid({ rows }: { rows: [string, ReactNode][] }): JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="pt-0.5 font-terminal text-[10px] text-muted-foreground">
            {k}
          </dt>
          <dd className="min-w-0 break-words text-[11px] text-foreground">
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
