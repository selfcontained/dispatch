// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { useState, type ReactNode } from "react";

import { DiffBlock } from "@/components/app/chat/stream-entries";
import { Markdown } from "@/components/ui/markdown";

import {
  CodeBlock,
  JsonBlock,
  looksLikePathList,
  OutputBlock,
  parseReadOutput,
  PathList,
  PlainBlock,
} from "./code-block";
import type { Step } from "./contracts";
import {
  hasChildren,
  hasSettledDetail,
  inputRecord,
  stepDetailData,
} from "./registry";
import { StepRow } from "./step-row";

/** The body under an expanded step, chosen by the step's kind. */
export function StepDetail({
  step,
  depth = 0,
}: {
  step: Step;
  /** 0 at the rail's top level; children render one deeper. */
  depth?: number;
}): JSX.Element | null {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const d = stepDetailData(step);
  if (hasChildren(step)) {
    return (
      <div className="mt-1.5 space-y-2" data-testid="harness-step-children">
        <DetailBody step={step} />
        <div className="relative pl-3">
          <span
            aria-hidden="true"
            className="absolute bottom-1 left-[5.5px] top-1 w-px bg-border/70"
          />
          <div
            role="list"
            aria-label="subagent steps"
            data-testid="harness-nested-steps"
          >
            {step.children!.map((child) => (
              <StepRow
                key={child.id}
                step={child}
                open={openIds[child.id] ?? child.status === "running"}
                onToggle={() =>
                  setOpenIds((prev) => ({
                    ...prev,
                    [child.id]: !(prev[child.id] ?? child.status === "running"),
                  }))
                }
                maskClass="bg-muted"
                depth={depth + 1}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
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
  // A step still running has its input and nothing else: its arguments
  // are the body until the result lands, so the reader watches the call
  // it is waiting on rather than a bare label. A command string is
  // settled detail in its own right, so an execute step keeps CommandLine.
  const command = input?.command ?? input?.cmd;
  if (
    step.status === "running" &&
    !hasSettledDetail(step) &&
    !(step.kind === "execute" && typeof command === "string")
  ) {
    return <Args input={d.input} />;
  }
  switch (step.kind) {
    case "execute":
      return (
        <>
          {typeof command === "string" ? (
            <CommandLine command={command} />
          ) : null}
          <OutputBlock text={d.terminalOutput} />
        </>
      );
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

/** Past this many lines a command (a heredoc, a script) is clipped like output. */
const COMMAND_INLINE_LINES = 4;

function CommandLine({ command }: { command: string }): JSX.Element {
  const lines = command.split("\n");
  if (lines.length > COMMAND_INLINE_LINES) {
    return <PlainBlock text={`$ ${command}`} />;
  }
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
        <JsonBlock value={value} />
      ) : typeof value === "string" && value.includes("\n") ? (
        <PlainBlock text={value} />
      ) : (
        <span className="break-words [overflow-wrap:anywhere]">
          {String(value)}
        </span>
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
