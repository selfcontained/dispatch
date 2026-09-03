import { useMemo } from "react";
import type {
  ChatFeedEntry,
  ChatMessage,
  ChatQuestionOption,
  ChatStatusEntry,
} from "@dispatch/shared";

import {
  AgentMessageView,
  agentMessageAuthor,
  type AttachmentContext,
  ChatMessageView,
  DayDivider,
  dayLabel,
  MediaEntryView,
  StatusLine,
} from "@/components/app/chat/chat-entries";

/**
 * A feed entry ready to render: status lines may stand in for a run of
 * consecutive `working` events, in which case `collapsedCount` says how many.
 */
export type ChatFeedItem =
  | { kind: "entry"; entry: Exclude<ChatFeedEntry, ChatStatusEntry> }
  | { kind: "status"; entry: ChatStatusEntry; collapsedCount: number };

/**
 * What the channel draws, top to bottom: day rules, system lines, and posts
 * that know whether they continue the post above them.
 */
export type ChatFeedRow =
  | { kind: "divider"; key: string; label: string }
  | { kind: "status"; entry: ChatStatusEntry; collapsedCount: number }
  | {
      kind: "entry";
      entry: Exclude<ChatFeedEntry, ChatStatusEntry>;
      grouped: boolean;
    };

/** Posts by one author this close together share a header, like Slack. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Agents emit a `working` event for every little step. Back-to-back ones say
 * nothing a single line can't, so a run collapses to its latest member; any
 * other entry in between breaks the run.
 */
export function collapseFeed(entries: ChatFeedEntry[]): ChatFeedItem[] {
  const items: ChatFeedItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "status") {
      items.push({ kind: "entry", entry });
      continue;
    }
    const last = items[items.length - 1];
    if (
      entry.eventType === "working" &&
      last &&
      last.kind === "status" &&
      last.entry.eventType === "working"
    ) {
      items[items.length - 1] = {
        kind: "status",
        entry,
        collapsedCount: last.collapsedCount + 1,
      };
      continue;
    }
    items.push({ kind: "status", entry, collapsedCount: 1 });
  }
  return items;
}

function authorKey(
  entry: Exclude<ChatFeedEntry, ChatStatusEntry>,
  ctx: AttachmentContext
): string {
  switch (entry.type) {
    case "chat":
      return entry.message.authorKind === "user" ? "user" : "agent";
    case "agent_message":
      return agentMessageAuthor(entry, ctx).key;
    case "media":
      return "agent";
  }
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Lay the collapsed feed out as channel rows: a rule wherever the day
 * changes, and a post grouped under the previous one when the same author
 * posted it within {@link GROUP_WINDOW_MS} with nothing else in between.
 */
export function layoutFeed(
  entries: ChatFeedEntry[],
  ctx: AttachmentContext,
  now: Date = new Date()
): ChatFeedRow[] {
  const rows: ChatFeedRow[] = [];
  let lastDay: string | null = null;
  let lastPost: { key: string; at: number } | null = null;
  for (const item of collapseFeed(entries)) {
    const day = dayKey(item.entry.at);
    if (day !== lastDay) {
      rows.push({
        kind: "divider",
        key: `day:${day}`,
        label: dayLabel(item.entry.at, now),
      });
      lastDay = day;
      lastPost = null;
    }
    if (item.kind === "status") {
      rows.push(item);
      lastPost = null;
      continue;
    }
    const key = authorKey(item.entry, ctx);
    const at = new Date(item.entry.at).getTime();
    const grouped =
      lastPost !== null &&
      lastPost.key === key &&
      Number.isFinite(at) &&
      at - lastPost.at <= GROUP_WINDOW_MS;
    rows.push({ kind: "entry", entry: item.entry, grouped });
    lastPost = { key, at: Number.isFinite(at) ? at : 0 };
  }
  return rows;
}

/** The id of the most recent user message, for the hold hint. */
export function latestUserMessageId(entries: ChatFeedEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "chat" && entry.message.authorKind === "user") {
      return entry.message.id;
    }
  }
  return null;
}

/**
 * The newest unanswered question that accepts a typed reply. While one is
 * open the composer answers it instead of sending a plain message.
 */
export function latestOpenFreeformQuestion(
  entries: ChatFeedEntry[]
): ChatMessage | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== "chat") continue;
    const m = entry.message;
    if (m.authorKind !== "agent" || m.kind !== "question") continue;
    if (m.answer !== null) continue;
    return m.question?.allowFreeform ? m : null;
  }
  return null;
}

/** The id of the most recent agent message, the `upTo` for mark-read. */
export function latestAgentMessageId(entries: ChatFeedEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "chat" && entry.message.authorKind === "agent") {
      return entry.message.id;
    }
  }
  return null;
}

export type ChatFeedProps = {
  entries: ChatFeedEntry[];
  ctx: AttachmentContext;
  /** Message currently waiting out the injection hold, if any. */
  heldMessageId: string | null;
  /** Question whose answer is in flight, if any. */
  answeringMessageId: string | null;
  /** Answers go through the same injection as the composer; lock them together. */
  answersDisabled?: boolean;
  onAnswer: (messageId: string, option: ChatQuestionOption) => void;
};

export function ChatFeed({
  entries,
  ctx,
  heldMessageId,
  answeringMessageId,
  answersDisabled = false,
  onAnswer,
}: ChatFeedProps): JSX.Element {
  const rows = useMemo(() => layoutFeed(entries, ctx), [entries, ctx]);

  return (
    <div className="flex flex-col pb-1" data-testid="chat-feed">
      {rows.map((row) => {
        if (row.kind === "divider") {
          return <DayDivider key={row.key} label={row.label} />;
        }
        if (row.kind === "status") {
          return (
            <StatusLine
              key={row.entry.id}
              entry={row.entry}
              collapsedCount={row.collapsedCount}
            />
          );
        }
        const entry = row.entry;
        switch (entry.type) {
          case "chat":
            return (
              <ChatMessageView
                key={entry.id}
                message={entry.message}
                held={heldMessageId === entry.message.id}
                grouped={row.grouped}
                ctx={ctx}
                answering={
                  answersDisabled || answeringMessageId === entry.message.id
                }
                freeformAvailable={!answersDisabled}
                onAnswer={onAnswer}
              />
            );
          case "agent_message":
            return (
              <AgentMessageView
                key={entry.id}
                entry={entry}
                grouped={row.grouped}
                ctx={ctx}
              />
            );
          case "media":
            return (
              <MediaEntryView
                key={entry.id}
                entry={entry}
                grouped={row.grouped}
                ctx={ctx}
              />
            );
        }
      })}
    </div>
  );
}
