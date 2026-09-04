import { type ReactNode, useMemo, useRef } from "react";
import type {
  ChatFeedEntry,
  ChatMessage,
  ChatQuestionOption,
  ChatStatusEntry,
} from "@dispatch/shared";

import {
  AgentMessageView,
  agentMessageAuthor,
  chatMessageAuthor,
  type FeedContext,
  ChatMessageView,
  DayDivider,
  dayLabel,
  MediaEntryView,
  reviewAuthor,
  ReviewEntryView,
  StatusLine,
} from "@/components/app/chat/chat-entries";
import {
  ActivityEntryView,
  AssistantEntryView,
} from "@/components/app/chat/stream-entries";

/**
 * A feed entry ready to render: status lines may stand in for a run of
 * consecutive `working` events, in which case `collapsedCount` says how many.
 */
type ChatFeedItem =
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
      /**
       * A hairline above this post: it starts a new author group right after
       * another post. Off when a day rule or a status cluster already sits
       * between the two, so nothing is separated twice.
       */
      rule: boolean;
    };

/** Posts by one author this close together share a header, like Slack. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * What "the same entry, changed" means: a post edited in place has a new
 * one, and so does a stream row that grew or settled since the last render.
 */
export function entryVersion(entry: ChatFeedEntry): string {
  switch (entry.type) {
    case "chat":
      return entry.message.updatedAt;
    case "assistant":
      return `${entry.at}:${entry.text.length}:${entry.streaming ? 1 : 0}`;
    case "activity":
      return `${entry.at}:${entry.status}:${entry.terminalOutput?.length ?? 0}:${entry.diff ? 1 : 0}`;
    default:
      return entry.at;
  }
}

/**
 * The entries to fade in: those that arrived after the feed first rendered,
 * plus posts edited in place — never what was there at mount, and never a
 * page of older entries. An unseen id is an arrival when it is at least as
 * new as the newest entry seen so far; anything older came in above with
 * "Load older". The value is the version the animation belongs to, so an
 * edit of an entry that already faded in fades it in again.
 *
 * Bookkeeping lives in refs and is updated during render: it only ever
 * adds to the answer for the current entries, so a repeated render (strict
 * mode) settles on the same result.
 */
export function useEnteringEntries(
  entries: ChatFeedEntry[]
): ReadonlyMap<string, string> {
  const seenRef = useRef<Map<string, string> | null>(null);
  const newestAtRef = useRef("");
  const enteringRef = useRef(new Map<string, string>());

  if (seenRef.current === null) {
    seenRef.current = new Map(
      entries.map((entry) => [entry.id, entryVersion(entry)])
    );
    for (const entry of entries) {
      if (entry.at > newestAtRef.current) newestAtRef.current = entry.at;
    }
    return enteringRef.current;
  }

  const seen = seenRef.current;
  const entering = enteringRef.current;
  const present = new Set<string>();
  let newest = newestAtRef.current;
  for (const entry of entries) {
    present.add(entry.id);
    const version = entryVersion(entry);
    const prior = seen.get(entry.id);
    if (prior === undefined) {
      if (entry.at >= newestAtRef.current) entering.set(entry.id, version);
    } else if (prior !== version) {
      entering.set(entry.id, version);
    }
    seen.set(entry.id, version);
    if (entry.at > newest) newest = entry.at;
  }
  newestAtRef.current = newest;
  for (const id of [...seen.keys()]) {
    if (!present.has(id)) {
      seen.delete(id);
      entering.delete(id);
    }
  }
  return entering;
}

/**
 * Fades a fresh entry in (a short rise with it, unless the viewer prefers
 * reduced motion, in which case it simply appears). Keyed by the version so
 * an in-place edit runs it again; a settled entry renders bare.
 */
function Enter({
  id,
  entering,
  children,
}: {
  id: string;
  entering: ReadonlyMap<string, string>;
  children: ReactNode;
}): JSX.Element {
  const version = entering.get(id);
  if (version === undefined) return <>{children}</>;
  return (
    <div
      key={version}
      className="animate-chat-enter motion-reduce:animate-none"
      data-testid="chat-entry-enter"
    >
      {children}
    </div>
  );
}

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
  ctx: FeedContext
): string {
  switch (entry.type) {
    case "chat":
      return chatMessageAuthor(entry.message, ctx).key;
    case "agent_message":
      return agentMessageAuthor(entry, ctx).key;
    case "media":
      return "agent";
    case "review":
      return reviewAuthor(entry, ctx).key;
    case "assistant":
    case "activity":
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
  ctx: FeedContext,
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
    const rule = !grouped && rows[rows.length - 1]?.kind === "entry";
    rows.push({ kind: "entry", entry: item.entry, grouped, rule });
    // Tool activity rides under the agent's current post without becoming
    // one: the assistant text that follows a tool run still opens with the
    // agent's avatar and name instead of trailing headerless.
    if (item.entry.type === "activity") continue;
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
  ctx: FeedContext;
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
  const entering = useEnteringEntries(entries);

  // Consecutive status lines sit as one quiet cluster between posts, so they
  // read as a separator rather than as posts of their own.
  const blocks = useMemo(() => {
    const out: Array<
      | { kind: "row"; row: ChatFeedRow }
      | {
          kind: "statuses";
          key: string;
          rows: Extract<ChatFeedRow, { kind: "status" }>[];
        }
    > = [];
    for (const row of rows) {
      if (row.kind !== "status") {
        out.push({ kind: "row", row });
        continue;
      }
      const last = out[out.length - 1];
      if (last?.kind === "statuses") {
        last.rows.push(row);
      } else {
        out.push({ kind: "statuses", key: row.entry.id, rows: [row] });
      }
    }
    return out;
  }, [rows]);

  return (
    <div
      className="flex min-w-0 max-w-full flex-col overflow-x-hidden pb-1"
      data-testid="chat-feed"
    >
      {blocks.map((block) => {
        if (block.kind === "statuses") {
          return (
            <div
              key={`statuses:${block.key}`}
              className="my-1.5 flex flex-col"
              data-testid="chat-status-cluster"
            >
              {block.rows.map((row) => (
                <Enter key={row.entry.id} id={row.entry.id} entering={entering}>
                  <StatusLine
                    entry={row.entry}
                    collapsedCount={row.collapsedCount}
                  />
                </Enter>
              ))}
            </div>
          );
        }
        const row = block.row;
        if (row.kind === "divider") {
          return <DayDivider key={row.key} label={row.label} />;
        }
        if (row.kind === "status") return null;
        const entry = row.entry;
        const view = (() => {
          switch (entry.type) {
            case "chat":
              return (
                <ChatMessageView
                  message={entry.message}
                  held={heldMessageId === entry.message.id}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                  answering={answeringMessageId === entry.message.id}
                  answersDisabled={answersDisabled}
                  onAnswer={onAnswer}
                />
              );
            case "agent_message":
              return (
                <AgentMessageView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
            case "media":
              return (
                <MediaEntryView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
            case "review":
              return (
                <ReviewEntryView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
            case "assistant":
              return (
                <AssistantEntryView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
            case "activity":
              return (
                <ActivityEntryView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
          }
        })();
        return (
          <Enter key={entry.id} id={entry.id} entering={entering}>
            {view}
          </Enter>
        );
      })}
    </div>
  );
}
