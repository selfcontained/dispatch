import { useState } from "react";
import type { ChatActivityEntry, ChatAssistantEntry } from "@dispatch/shared";

import {
  agentAuthor,
  type FeedContext,
  Post,
  POST_BODY_MEASURE,
  SIDE_POST_INDENT,
} from "@/components/app/chat/chat-entries";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

// Entries from a stream-driven harness (dsh over ACP): the agent's own text
// and its tool calls, rendered from agent_stream_events rows.

/** Assistant text from the harness stream: the agent's own post. */
export function AssistantEntryView({
  entry,
  grouped,
  rule = false,
  ctx,
}: {
  entry: ChatAssistantEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  return (
    <Post
      author={agentAuthor(ctx)}
      at={entry.at}
      grouped={grouped}
      rule={rule}
      data-testid="chat-assistant"
    >
      <div className={cn(POST_BODY_MEASURE, "min-w-0")}>
        <Markdown>{entry.text}</Markdown>
        {entry.streaming ? (
          <span
            aria-label="streaming"
            className="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-status-working align-baseline"
          />
        ) : null}
      </div>
    </Post>
  );
}

const ACTIVITY_STATUS_CLASS: Record<ChatActivityEntry["status"], string> = {
  pending: "bg-muted-foreground/40",
  in_progress: "bg-status-working",
  completed: "bg-status-done",
  failed: "bg-status-blocked",
};

/** A line-by-line diff for an activity card; enough for a prototype view. */
export function renderUnifiedDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) {
      out.push(`  ${a[i] ?? ""}`);
      continue;
    }
    if (i < a.length) out.push(`- ${a[i]}`);
    if (i < b.length) out.push(`+ ${b[i]}`);
  }
  return out.join("\n");
}

/**
 * One tool call from the harness stream: a compact row under the agent's
 * posts, expandable when it carries a diff or terminal output.
 */
export function ActivityEntryView({
  entry,
  grouped,
  rule = false,
}: {
  entry: ChatActivityEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = entry.diff !== null || entry.terminalOutput !== null;
  const location = entry.locations[0]?.path ?? null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 pr-4 text-xs text-muted-foreground",
        SIDE_POST_INDENT,
        grouped ? "py-0.5" : "mt-2 py-0.5",
        rule && "border-t border-border/40 pt-2"
      )}
      data-testid="chat-activity"
      data-status={entry.status}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 items-center gap-2 text-left",
          expandable ? "cursor-pointer hover:text-foreground" : "cursor-default"
        )}
        onClick={() => {
          if (expandable) setOpen((v) => !v);
        }}
        aria-expanded={expandable ? open : undefined}
      >
        <span
          aria-label={entry.status}
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            ACTIVITY_STATUS_CLASS[entry.status]
          )}
        />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] opacity-70">
          {entry.toolKind}
        </span>
        <span className="truncate text-foreground/80">{entry.title}</span>
        {location ? (
          <span className="truncate font-mono opacity-60">{location}</span>
        ) : null}
      </button>
      {open && entry.diff ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-terminal text-[11px] leading-snug">
          {renderUnifiedDiff(entry.diff.oldText ?? "", entry.diff.newText)}
        </pre>
      ) : null}
      {open && entry.terminalOutput ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-terminal text-[11px] leading-snug">
          {entry.terminalOutput}
        </pre>
      ) : null}
    </div>
  );
}
