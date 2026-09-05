// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo, useState } from "react";
import { Bell } from "lucide-react";

import { cn } from "@/lib/utils";

import { ExpandableBlock } from "./code-block";
import type { Attachment, Turn } from "./contracts";

const KEY_VALUE = /^([A-Za-z][A-Za-z ]{0,30}):\s*(.*)$/;

/** "Review ID: 293" → key and value, for coloured rendering. */
export function splitKeyValue(
  line: string
): { key: string; value: string } | null {
  const m = KEY_VALUE.exec(line.trim());
  return m ? { key: m[1], value: m[2] } : null;
}

/** A line with its key in the accent colour and its value in the foreground. */
function KeyValueText({ line }: { line: string }): JSX.Element {
  const kv = splitKeyValue(line);
  if (!kv) return <span className="text-foreground/75">{line}</span>;
  return (
    <>
      <span className="text-status-working">{kv.key}:</span>{" "}
      <span className="text-foreground">{kv.value}</span>
    </>
  );
}

const CHIP_CLASS =
  "inline-flex max-w-[240px] items-center truncate rounded-[2px] border border-border bg-background px-1.5 py-0.5 text-[10.5px] text-foreground/80";

const BLOCK_HEADER = /^---\s*DISPATCH:\s*([^-\n][^\n]*?)\s*---\s*\n?/i;
const BLOCK_FOOTER = /\n?---\s*END\s+DISPATCH:[^\n]*---\s*$/i;

export type DispatchNotice = {
  /** "Review item resolved", "System", … */
  label: string;
  /** "Review ID: 293 · Feedback item ID: 1422 · State: resolved" */
  summary: string;
  body: string;
};

function titleCase(kind: string): string {
  const lower = kind.trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Prompts Dispatch itself injects — review thread updates, persona
 * kickoffs, the rename nudge — read as a notice, not as something the
 * user typed. A `--- DISPATCH: KIND ---` block names its kind; any other
 * system-sourced prompt is a plain "System" notice.
 */
export function parseDispatchNotice(
  text: string,
  source: string | undefined
): DispatchNotice | null {
  const header = BLOCK_HEADER.exec(text);
  if (!header && source !== "system") return null;
  const body = (header ? text.slice(header[0].length) : text)
    .replace(BLOCK_FOOTER, "")
    .trim();
  const lines = body.split("\n").map((l) => l.trim());
  const kv = lines
    .filter((l) => /^[A-Za-z][A-Za-z ]{0,30}:\s*\S/.test(l))
    .slice(0, 3);
  const summary =
    kv.length > 0
      ? kv.map((l) => l.replace(/\s+/g, " ")).join(" · ")
      : (lines.find((l) => l.length > 0) ?? "").slice(0, 120);
  return {
    label: header ? titleCase(header[1]) : "System",
    summary,
    body,
  };
}

function PromptLineImpl({
  turn,
  onAttachmentClick,
}: {
  turn: Turn;
  onAttachmentClick?: (a: Attachment) => void;
}): JSX.Element {
  const source =
    typeof turn.extra?.source === "string" ? turn.extra.source : undefined;
  const notice = parseDispatchNotice(turn.content, source);
  if (notice) return <NoticeLine notice={notice} />;
  const attachments = turn.attachments ?? [];
  const contextChips = turn.contextChips ?? [];
  return (
    <div className="mb-3.5" data-testid="harness-prompt">
      <div className="flex items-start gap-[9px]">
        <span
          aria-hidden="true"
          className="select-none text-[13px] font-bold leading-[1.55] text-status-working"
        >
          ›
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-foreground">
          {turn.content}
        </p>
      </div>
      {contextChips.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-[5px] pl-[21px]">
          {contextChips.map((chip, i) => (
            <span key={`${chip.label}:${i}`} className={CHIP_CLASS}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2 pl-[21px]">
          {attachments.map((a, i) =>
            a.kind === "image" ? (
              <img
                key={`${a.url}:${i}`}
                src={a.url}
                alt={a.name ?? `Attached image ${i + 1}`}
                className="h-16 w-16 cursor-pointer rounded-[2px] object-cover hover:ring-2 hover:ring-status-working/50"
                onClick={() => onAttachmentClick?.(a)}
              />
            ) : (
              <span key={`${a.url}:${i}`} className={CHIP_CLASS}>
                {a.name ?? a.kind}
              </span>
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

export const PromptLine = memo(PromptLineImpl);

/** A Dispatch-injected prompt: one muted line, the full text on demand. */
function NoticeLine({ notice }: { notice: DispatchNotice }): JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = notice.body.length > notice.summary.length;
  return (
    <div className="mb-3.5" data-testid="harness-notice">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "flex w-full items-start gap-[9px] rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50",
          !expandable && "cursor-default"
        )}
      >
        <span
          aria-hidden="true"
          className="flex h-[19px] w-[13px] shrink-0 items-center justify-center text-muted-foreground"
        >
          <Bell className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 text-[11.5px] leading-[1.55]">
          <span className="mr-1.5 rounded-[2px] border border-status-working/30 bg-status-working/10 px-1.5 py-px text-[10px] uppercase tracking-wide text-status-working">
            Dispatch · {notice.label}
          </span>
          {notice.summary.split(" · ").map((part, i) => (
            <span key={`${part}:${i}`}>
              {i > 0 ? (
                <span className="text-muted-foreground/60"> · </span>
              ) : null}
              <KeyValueText line={part} />
            </span>
          ))}
        </span>
        {expandable ? (
          <span
            aria-hidden="true"
            className="shrink-0 pt-1 text-[9px] text-muted-foreground/70"
          >
            {open ? "⏷" : "⏵"}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-[21px] mt-1.5">
          <ExpandableBlock
            lineCount={notice.body.split("\n").length}
            className="border border-border/40 !bg-muted/40"
            testId="harness-notice-body"
          >
            <div className="whitespace-pre-wrap break-words p-2 font-terminal text-[11px] leading-[1.5] [overflow-wrap:anywhere]">
              {notice.body.split("\n").map((line, i) => (
                <div key={i}>
                  <KeyValueText line={line} />
                </div>
              ))}
            </div>
          </ExpandableBlock>
        </div>
      ) : null}
    </div>
  );
}
