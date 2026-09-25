import { memo } from "react";
import type {
  ChatTurnEntry,
  StreamBlockEntry,
  StreamEntry,
} from "@dispatch/shared";
import { ChevronRight } from "lucide-react";

import { LinkBlockBody } from "@/components/app/chat/block-bodies";
import { AttachmentList } from "@/components/app/chat/chat-attachment-views";
import {
  agentDisplayName,
  type FeedContext,
} from "@/components/app/chat/chat-entries";
import {
  DeliveryDetails,
  DeliveryMeta,
} from "@/components/app/chat/chat-delivery-meta";
import { useChatRowState } from "@/components/app/chat/chat-row-state";
import { Collapse } from "@/components/app/chat/collapse";
import { cn } from "@/lib/utils";

/**
 * A feed entry the agent produced while a turn was running: a file or link
 * block it posted, a post it sent to another agent. Each one is still its
 * own row on the wire; the feed folds it into the turn's post so the work
 * reads as one story instead of a post per side effect.
 */
export type FoldedEntry = StreamBlockEntry;

/** An agent's post to another agent (`toAgentId` set): the "Sent to" fold. */
export function isSentTo(entry: StreamEntry, agentId?: string): boolean {
  return (
    entry.type === "block" &&
    entry.block.author.kind === "agent" &&
    entry.block.toAgentId !== null &&
    (agentId === undefined || entry.block.author.agentId === agentId)
  );
}

/**
 * Whether a row folds into the turn above it. `agentId` is the agent whose
 * turns the folds belong to: only its own posts to other agents fold, so a
 * child's post to its parent stays a post of its own in the parent's feed.
 */
export function isFoldable(
  entry: StreamEntry,
  agentId?: string
): entry is FoldedEntry {
  if (entry.type !== "block" || entry.block.author.kind !== "agent") {
    return false;
  }
  if (entry.block.turn) return false;
  if (agentId !== undefined && entry.block.author.agentId !== agentId) {
    return false;
  }
  if (isSentTo(entry, agentId)) return true;
  if (entry.block.threadId !== null) return false;
  if (entry.block.kind === "file" || entry.block.kind === "link") return true;
  // A plain post that carries attachments is the agent handing something
  // over mid-turn (a screenshot, a PR, a snippet): its text is the caption.
  return entry.block.kind === "text" && entry.block.attachments.length > 0;
}

/**
 * The window a turn owns: from its start to its end, open-ended while it
 * runs. `updatedAt` stands in for the end of a settled turn that never
 * recorded one (a turn cut by a restart).
 */
export function turnWindow(turn: ChatTurnEntry): {
  start: number;
  end: number;
} {
  const start = Date.parse(turn.trace.startedAt);
  const end = turn.settled
    ? Date.parse(turn.trace.endedAt ?? turn.updatedAt)
    : Number.POSITIVE_INFINITY;
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : Number.POSITIVE_INFINITY,
  };
}

/**
 * Fold every foldable entry into the turn whose window holds it. Entries
 * arrive in feed order, so the nearest turn above an entry is the only
 * candidate; anything that falls outside its window (a link posted between
 * turns, a file shared by a person's hand) stays a post of its own.
 *
 * The feed carries the turns of every agent in the root's tree, each a
 * block of that agent's with its turn attached. Only the page agent's
 * (`agentId`) rows fold, and only under its own turns: a child's turn in
 * between does not close the window, and a child's file or post stays a
 * post by the child, where the reader can see it without opening the
 * child's folded turn.
 */
export function foldAttachments(
  entries: readonly StreamEntry[],
  agentId?: string
): {
  entries: StreamEntry[];
  folded: ReadonlyMap<string, FoldedEntry[]>;
} {
  const out: StreamEntry[] = [];
  const folded = new Map<string, FoldedEntry[]>();
  let open: { id: string; window: { start: number; end: number } } | null =
    null;
  for (const entry of entries) {
    const turn = entry.block.turn;
    if (turn) {
      const by =
        entry.block.author.kind === "agent" ? entry.block.author.agentId : null;
      if (agentId === undefined || by === agentId) {
        open = { id: entry.id, window: turnWindow(turn) };
      }
      out.push(entry);
      continue;
    }
    if (open && isFoldable(entry, agentId)) {
      const at = Date.parse(entry.at);
      if (at >= open.window.start && at <= open.window.end) {
        const list = folded.get(open.id);
        if (list) list.push(entry);
        else folded.set(open.id, [entry]);
        continue;
      }
    }
    out.push(entry);
  }
  return { entries: out, folded };
}

/**
 * A file or link the agent posted mid-turn: its text (the description) in
 * the step list's quiet tone, then the file's own card or the link's.
 */
function FoldedBlock({
  entry,
  ctx,
}: {
  entry: StreamBlockEntry;
  ctx: FeedContext;
}): JSX.Element {
  const { block } = entry;
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="chat-turn-block"
      data-kind={block.kind}
    >
      {block.text ? (
        <div className="text-xs text-muted-foreground">{block.text}</div>
      ) : null}
      {block.kind === "link" ? <LinkBlockBody block={block} /> : null}
      <AttachmentList block={block} ctx={ctx} />
    </div>
  );
}

/** The first line with anything on it: what a closed sent-post shows. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/**
 * A post the agent made to another agent mid-turn (a reply to a child, a
 * nudge to a sibling). Sideband to the turn's own answer, so it folds the
 * way a launch briefing does: one line naming who it went to, where it has
 * got to and how it starts, with the whole post underneath.
 */
function SentTo({
  entry,
  ctx,
}: {
  entry: StreamBlockEntry;
  ctx: FeedContext;
}): JSX.Element {
  const { block } = entry;
  // Every fold in a turn shares the turn's row state, so the key is the post's.
  const [open, setOpen] = useChatRowState<boolean>(
    `sent-to-open:${block.id}`,
    false
  );
  const recipientName = agentDisplayName(block.toAgentId ?? "", ctx);
  const preview = firstLine(block.text);
  const openable = Boolean(block.text) || block.attachments.length > 0;
  return (
    <div
      className="group flex min-w-0 flex-col text-xs"
      data-testid="chat-turn-sent-to"
      data-to-agent={block.toAgentId ?? undefined}
      data-block-id={block.id}
      data-open={open ? "true" : "false"}
    >
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <button
          type="button"
          onClick={() => openable && setOpen(!open)}
          aria-expanded={openable ? open : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left",
            !openable && "cursor-default"
          )}
          data-testid="chat-turn-sent-to-toggle"
        >
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            Sent to
          </span>
          <span
            className="max-w-[40%] truncate font-medium text-foreground"
            title={recipientName}
          >
            {recipientName}
          </span>
          {preview ? (
            <span
              className="min-w-0 truncate"
              data-testid="chat-turn-sent-to-preview"
            >
              {preview}
            </span>
          ) : null}
          {openable ? (
            <ChevronRight
              className={cn(
                "ml-auto h-3.5 w-3.5 shrink-0 transition-transform",
                open && "rotate-90"
              )}
              aria-hidden="true"
            />
          ) : null}
        </button>
        <DeliveryDetails
          block={block}
          recipientName={(id) => agentDisplayName(id, ctx)}
        />
      </div>
      <DeliveryMeta
        block={block}
        recipientName={(id) => agentDisplayName(id, ctx)}
        retrying={ctx.retrying?.has(block.id)}
        onRetryDelivery={ctx.onRetryDelivery}
      />
      <Collapse open={open} data-testid="chat-turn-sent-to-body">
        <div className="flex min-w-0 flex-col gap-1 pt-1.5">
          {block.text ? (
            <div className="whitespace-pre-wrap break-words border-l-[3px] border-border pl-3 text-foreground/80">
              {block.text}
            </div>
          ) : null}
          <AttachmentList block={block} ctx={ctx} />
        </div>
      </Collapse>
    </div>
  );
}

/**
 * What the agent produced along the way, in the order it produced it,
 * between the step list and the answer: the answer still reads last, and the
 * things it refers to sit right above it.
 */
export const TurnAttachments = memo(function TurnAttachments({
  items,
  ctx,
}: {
  items: readonly FoldedEntry[];
  ctx: FeedContext;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div
      className="mt-3 mb-2 flex min-w-0 flex-col gap-2.5 font-sans first:mt-0"
      data-testid="chat-turn-attachments"
    >
      {items.map((item) =>
        isSentTo(item) ? (
          <SentTo key={item.id} entry={item} ctx={ctx} />
        ) : (
          <FoldedBlock key={item.id} entry={item} ctx={ctx} />
        )
      )}
    </div>
  );
});
