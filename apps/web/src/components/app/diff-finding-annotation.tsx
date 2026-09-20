/**
 * A review finding where it points: a card under the diff line it names,
 * folded to its status, severity and title, opening to the requested
 * change, the status controls and a way into its discussion in the drawer.
 * The same finding the review card lists; this is it in context.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessageSquare } from "lucide-react";

import {
  FindingActions,
  FindingStatusPill,
  findingOutcome,
  SeverityChip,
} from "@/components/app/chat/block-bodies";
import { Collapse } from "@/components/app/chat/collapse";
import { stickyAnnotationStyle } from "@/components/app/diff-annotation-style";
import type {
  DiffFinding,
  DiffFindingsProps,
} from "@/components/app/diff-review-annotation-props";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function InlineFindingAnnotation({
  item,
  focused,
  onFocusComplete,
  onOpen,
  onSetState,
  disabled,
  nameOf,
}: {
  item: DiffFinding;
  focused: boolean;
} & Pick<
  DiffFindingsProps,
  "onFocusComplete" | "onOpen" | "onSetState" | "disabled" | "nameOf"
>): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { block, finding, record } = item;
  const outcome = findingOutcome(record);

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    const frame = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const settle = window.setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      onFocusComplete(item.key);
    }, 220);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [focused, item.key, onFocusComplete]);

  const changedBy =
    record && (record.status !== "open" || record.note)
      ? `${
          outcome === "open"
            ? "Reopened"
            : outcome === "fixed"
              ? "Fixed"
              : "Dismissed"
        } by ${record.by.kind === "user" ? "you" : nameOf(record.by.agentId)}${
          record.at ? ` · ${formatRelativeTime(record.at)}` : ""
        }`
      : null;

  return (
    <div
      ref={ref}
      className={cn(
        "sticky left-0 my-3 ml-3 max-w-full overflow-clip rounded-md border-l-[3px] bg-card shadow-sm ring-1 ring-border/50",
        outcome === "open"
          ? "border-l-status-waiting"
          : outcome === "fixed"
            ? "border-l-status-done"
            : "border-l-border"
      )}
      style={stickyAnnotationStyle}
      data-testid="diff-finding"
      data-finding-key={item.key}
      data-status={record?.status ?? "open"}
      data-outcome={outcome}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="diff-finding-header"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-300",
            expanded && "rotate-90"
          )}
          aria-hidden="true"
        />
        <FindingStatusPill record={record} />
        <SeverityChip severity={finding.severity} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-medium text-foreground",
            record?.status === "resolved" &&
              "text-muted-foreground line-through"
          )}
          title={finding.title}
        >
          {finding.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {item.reviewerName}
        </span>
      </button>
      <Collapse open={expanded} data-testid="diff-finding-body">
        <div className="flex flex-col gap-2.5 border-t border-border/40 px-3 pb-3 pt-2.5">
          <Markdown className="text-xs text-foreground/90">
            {finding.body}
          </Markdown>
          {changedBy ? (
            <div className="text-[11px] text-muted-foreground">
              {changedBy}
              {record?.note ? (
                <span
                  className="block text-foreground/80"
                  data-testid="diff-finding-note"
                >
                  {record.note}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {onSetState ? (
              <FindingActions
                record={record}
                disabled={disabled}
                onPatch={(patch) => onSetState(block.id, finding.id, patch)}
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="ml-auto h-9 gap-1.5 text-xs"
              data-testid="diff-finding-open"
              onClick={() => onOpen(block.id, finding.id)}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              Discussion
            </Button>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
