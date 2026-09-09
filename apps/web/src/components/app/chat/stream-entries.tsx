import { AlertTriangle } from "lucide-react";
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
import { DiffBlock } from "@/components/app/chat/turn/diff-block";

// Entries from a stream-driven harness (an engine over ACP): the agent's own
// text and its tool calls, rendered from agent_stream_events rows.

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
            role="status"
            className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-working motion-reduce:animate-none"
            />
            Writing…
          </span>
        ) : null}
        {entry.truncated ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Message truncated: it passed the per-message size limit.
          </p>
        ) : null}
      </div>
    </Post>
  );
}

const ACTIVITY_STATUS_CLASS: Record<ChatActivityEntry["status"], string> = {
  pending: "bg-muted-foreground/40",
  in_progress: "animate-pulse bg-status-working motion-reduce:animate-none",
  completed: "bg-status-done",
  failed: "bg-status-blocked",
};

/**
 * One tool call from the harness stream. A compact row under the agent's
 * posts; the first row of a run carries the agent header so the reader
 * knows who is acting. Expandable only when it has a diff or output.
 */
export function ActivityEntryView({
  entry,
  grouped,
  rule = false,
  ctx,
}: {
  entry: ChatActivityEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = entry.diff !== null || entry.terminalOutput !== null;
  const location = entry.locations[0]?.path ?? null;
  const failed = entry.status === "failed";
  const status = entry.status.replace("_", " ");
  const rowClass = cn(
    "flex min-h-7 min-w-0 items-center gap-2 py-1 text-left text-xs text-muted-foreground",
    expandable ? "cursor-pointer hover:text-foreground" : "cursor-default"
  );
  const body = (
    <>
      <span
        role="img"
        aria-label={status}
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          ACTIVITY_STATUS_CLASS[entry.status]
        )}
      />
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] opacity-70"
      >
        {entry.toolKind}
      </span>
      {failed ? (
        <AlertTriangle
          className="h-3 w-3 shrink-0 text-destructive"
          aria-hidden="true"
        />
      ) : null}
      <span
        className={cn(
          "min-w-0 shrink-0 truncate",
          "max-w-[60%] sm:max-w-[50%]",
          failed ? "text-destructive" : "text-foreground/80"
        )}
      >
        {entry.title}
      </span>
      {location ? (
        <span
          aria-hidden="true"
          title={location}
          className="hidden min-w-0 truncate font-mono opacity-60 sm:inline"
        >
          {location}
        </span>
      ) : null}
    </>
  );
  const row = expandable ? (
    <button
      type="button"
      className={cn(rowClass, "w-full")}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-label={`${entry.title}, ${status}`}
    >
      {body}
    </button>
  ) : (
    <div className={rowClass}>{body}</div>
  );
  const details =
    open && expandable ? (
      <div className="flex flex-col gap-1 pb-1">
        {entry.diff ? (
          <DiffBlock
            oldText={entry.diff.oldText}
            newText={entry.diff.newText}
          />
        ) : null}
        {entry.terminalOutput ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-terminal text-[11px] leading-snug">
            {entry.terminalOutput}
          </pre>
        ) : null}
        {entry.truncated ? (
          <p className="text-[11px] text-muted-foreground">
            Output truncated: it passed the per-call size limit.
          </p>
        ) : null}
      </div>
    ) : null;

  if (!grouped) {
    // First row of a run: carry the agent header so the reader knows who
    // is acting before any assistant text arrives.
    return (
      <Post
        author={agentAuthor(ctx)}
        at={entry.at}
        grouped={false}
        rule={rule}
        data-testid="chat-activity"
        data-status={entry.status}
      >
        <div className={cn(POST_BODY_MEASURE, "min-w-0")}>
          {row}
          {details}
        </div>
      </Post>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col pr-4",
        SIDE_POST_INDENT,
        POST_BODY_MEASURE
      )}
      data-testid="chat-activity"
      data-status={entry.status}
    >
      {row}
      {details}
    </div>
  );
}
