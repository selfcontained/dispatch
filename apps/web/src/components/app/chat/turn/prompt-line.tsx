// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo, useState } from "react";
import { Bell, ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { ExpandableBlock } from "@/components/app/harness/code-block";
import type { Turn } from "./contracts";

const KEY_VALUE = /^([A-Za-z][A-Za-z ]{0,30}):\s*(.*)$/;

/** "Review ID: 293" → key and value, for colored rendering. */
export function splitKeyValue(
  line: string
): { key: string; value: string } | null {
  const m = KEY_VALUE.exec(line.trim());
  return m ? { key: m[1], value: m[2] } : null;
}

/** A line with its key in the accent color and its value in the foreground. */
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
 * Prompts Dispatch itself injects, such as review thread updates, persona
 * kickoffs, and the rename nudge, read as a notice, not as something the
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

/**
 * A Dispatch-injected prompt as a notice row. A typed prompt never reaches
 * this component: the turn entry renders it as the user's own post.
 */
function PromptLineImpl({ turn }: { turn: Turn }): JSX.Element | null {
  const source =
    typeof turn.extra?.source === "string" ? turn.extra.source : undefined;
  const notice = parseDispatchNotice(turn.content, source);
  return notice ? <NoticeLine notice={notice} /> : null;
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
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
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
