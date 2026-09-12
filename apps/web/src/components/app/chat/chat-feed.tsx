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
  PinEntryView,
  reviewAuthor,
  ReviewEntryView,
} from "@/components/app/chat/chat-entries";
import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";

/**
 * What the channel draws, top to bottom: day rules and posts that know
 * whether they continue the post above them. A status event draws nothing:
 * the presence line above the composer already shows the latest one.
 */
export type ChatFeedRow =
  | { kind: "divider"; key: string; label: string }
  | {
      kind: "entry";
      entry: Exclude<ChatFeedEntry, ChatStatusEntry>;
      grouped: boolean;
      /**
       * A hairline above this post: it starts a new author group right after
       * another post. Off when a day rule already sits between the two, so
       * nothing is separated twice.
       */
      rule: boolean;
    };

/** Posts by one author this close together share a header, like Slack. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * What "the same entry, changed" means for the fade-in: a post edited in
 * place has a new one. A stream row growing chunk by chunk is not a new
 * version here, or every chunk would remount the post and collapse an
 * expanded activity row; growth is {@link entryGrowthKey}'s business.
 */
export function entryVersion(entry: ChatFeedEntry): string {
  return entry.type === "chat" ? entry.message.updatedAt : entry.at;
}

/**
 * The tail entry's identity plus everything that makes it taller: text as it
 * streams in, a tool call's status or output. The pane keys its follow
 * logic on this so new content below the fold still pins the scroll.
 */
export function entryGrowthKey(entry: ChatFeedEntry): string {
  const base = `${entry.id}:${entryVersion(entry)}`;
  switch (entry.type) {
    case "turn":
      // Everything that makes a turn taller: the newest row folded in, the
      // rail's length, the answer as it streams, and the settle that folds
      // the rail. `entryVersion` stays the anchor time, so growth does not
      // re-fade the entry.
      return `${base}:${entry.updatedAt}:${entry.trace.steps.length}:${entry.result?.text.length ?? 0}:${entry.settled ? 1 : 0}`;
    default:
      return base;
  }
}

/**
 * The entries to fade in: those that arrived after the feed first rendered,
 * plus posts edited in place — never what was there at mount, and never a
 * page of older entries. An unseen id is an arrival when it is at least as
 * new as the newest entry seen so far, or when it sits below an entry that
 * was already here (a late status event lands by time under the newest
 * post); a page from "Load older" is the one thing that only ever lands
 * above everything seen. The value is the version the animation belongs
 * to, so an edit of an entry that already faded in fades it in again.
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
  let afterSeen = false;
  for (const entry of entries) {
    present.add(entry.id);
    const version = entryVersion(entry);
    const prior = seen.get(entry.id);
    if (prior === undefined) {
      // New here, and either newer than anything seen or sitting below a
      // row that was already here: a live arrival, wherever time put it.
      // Only a page of older rows lands above everything seen.
      if (entry.at >= newestAtRef.current || afterSeen) {
        entering.set(entry.id, version);
      }
    } else {
      afterSeen = true;
      if (prior !== version) entering.set(entry.id, version);
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
 * Ids of entries that were not in `seen` and sit below one that was — live
 * arrivals, as opposed to a page of older rows, which lands above every
 * seen entry. Empty when nothing was seen yet (first render).
 */
export function arrivedEntryIds(
  seen: ReadonlySet<string>,
  entries: readonly ChatFeedEntry[]
): string[] {
  const arrived: string[] = [];
  let afterSeen = false;
  for (const entry of entries) {
    if (seen.has(entry.id)) afterSeen = true;
    else if (afterSeen) arrived.push(entry.id);
  }
  return arrived;
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
  // Always a real element, animating or not: `data-chat-entry-id` is how
  // ChatPane names the row a reader was parked on so it can put them back
  // there when the feed reopens.
  return (
    <div
      key={version}
      data-chat-entry-id={id}
      className={
        version === undefined
          ? undefined
          : "animate-chat-enter motion-reduce:animate-none"
      }
      data-testid={version === undefined ? undefined : "chat-entry-enter"}
    >
      {children}
    </div>
  );
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
    case "pin":
      return "agent";
    case "review":
      return reviewAuthor(entry, ctx).key;
    case "turn":
      // Never reached: `layoutFeed` gives a turn its own group before it
      // asks for an author key.
      return "turn";
  }
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Lay the feed out as channel rows: a rule wherever the day changes, and a
 * post grouped under the previous one when the same author posted it within
 * {@link GROUP_WINDOW_MS} with nothing else in between. Status events are
 * passed over as if they were not there.
 */
export function layoutFeed(
  entries: ChatFeedEntry[],
  ctx: FeedContext,
  now: Date = new Date()
): ChatFeedRow[] {
  const rows: ChatFeedRow[] = [];
  let lastDay: string | null = null;
  let lastPost: { key: string; at: number } | null = null;
  for (const entry of entries) {
    if (entry.type === "status") continue;
    const day = dayKey(entry.at);
    if (day !== lastDay) {
      rows.push({
        kind: "divider",
        key: `day:${day}`,
        label: dayLabel(entry.at, now),
      });
      lastDay = day;
      lastPost = null;
    }
    // A turn carries a user post and an agent post inside one entry, so
    // nothing outside it can group with either half: it always starts a
    // fresh group, draws no hairline of its own, and ends the run behind
    // it so the post after it opens with a header.
    if (entry.type === "turn") {
      rows.push({ kind: "entry", entry, grouped: false, rule: false });
      lastPost = null;
      continue;
    }
    const key = authorKey(entry, ctx);
    const at = new Date(entry.at).getTime();
    const safeAt = Number.isFinite(at) ? at : 0;
    const within = (since: number) =>
      Number.isFinite(at) && at - since <= GROUP_WINDOW_MS;
    const grouped =
      lastPost !== null && lastPost.key === key && within(lastPost.at);
    const rule = !grouped && rows[rows.length - 1]?.kind === "entry";
    rows.push({ kind: "entry", entry, grouped, rule });
    lastPost = { key, at: safeAt };
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
 *
 * A turn names the questions asked during it and whether each is answered.
 * A question's card is a `chat` entry of its own, in time order, and always
 * lands after the turn's anchor, so the walk below finds the card either
 * way; what the turn adds is a fresher answer state. The turn entry is
 * republished whole on every flush, while a cached chat row is only as new
 * as its last event, so an answer the turn knows about closes the question
 * even when the row has not caught up.
 */
export function latestOpenFreeformQuestion(
  entries: ChatFeedEntry[]
): ChatMessage | null {
  const answeredByTurn = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "turn") continue;
    for (const ref of entry.questions ?? []) {
      if (ref.answered) answeredByTurn.add(ref.messageId);
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== "chat") continue;
    const m = entry.message;
    if (m.authorKind !== "agent" || m.kind !== "question") continue;
    if (m.answer !== null || answeredByTurn.has(m.id)) continue;
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
  const messageDirectory = useMemo(
    () =>
      new Map(
        entries
          .filter((entry) => entry.type === "chat")
          .map((entry) => [entry.message.id, entry.message] as const)
      ),
    [entries]
  );
  const rows = useMemo(() => layoutFeed(entries, ctx), [entries, ctx]);
  const entering = useEnteringEntries(entries);

  return (
    <div
      className="flex min-w-0 max-w-full flex-col overflow-x-hidden pb-1"
      data-testid="chat-feed"
    >
      {rows.map((row) => {
        if (row.kind === "divider") {
          return <DayDivider key={row.key} label={row.label} />;
        }
        const entry = row.entry;
        const answeredOptionLabel = (() => {
          if (entry.type !== "chat" || !entry.message.replyTo) return null;
          const question = messageDirectory.get(entry.message.replyTo);
          if (question?.answer?.replyMessageId !== entry.message.id)
            return null;
          const option = question.question?.options.find(
            (candidate) =>
              (candidate.value ?? candidate.label) === question.answer?.value
          );
          return option?.label ?? null;
        })();
        const view = ((): JSX.Element | null => {
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
                  answeredOptionLabel={answeredOptionLabel}
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
            case "turn":
              return (
                <TurnEntryView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
            case "pin":
              return (
                <PinEntryView
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
