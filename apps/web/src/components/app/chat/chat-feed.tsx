import { useMemo } from "react";
import type {
  ChatFeedEntry,
  ChatMessage,
  ChatQuestionOption,
  ChatStatusEntry,
} from "@dispatch/shared";

import {
  AgentMessageView,
  type AttachmentContext,
  ChatMessageView,
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
  const items = useMemo(() => collapseFeed(entries), [entries]);

  return (
    <div className="flex flex-col gap-3" data-testid="chat-feed">
      {items.map((item) => {
        if (item.kind === "status") {
          return (
            <StatusLine
              key={item.entry.id}
              entry={item.entry}
              collapsedCount={item.collapsedCount}
            />
          );
        }
        const entry = item.entry;
        switch (entry.type) {
          case "chat":
            return (
              <ChatMessageView
                key={entry.id}
                message={entry.message}
                held={heldMessageId === entry.message.id}
                ctx={ctx}
                answering={
                  answersDisabled || answeringMessageId === entry.message.id
                }
                freeformAvailable={!answersDisabled}
                onAnswer={onAnswer}
              />
            );
          case "agent_message":
            return <AgentMessageView key={entry.id} entry={entry} />;
          case "media":
            return <MediaEntryView key={entry.id} entry={entry} ctx={ctx} />;
        }
      })}
    </div>
  );
}
