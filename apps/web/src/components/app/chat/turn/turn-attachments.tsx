import { memo } from "react";
import type {
  ChatAgentMessageEntry,
  ChatFeedEntry,
  ChatMediaEntry,
  ChatPinEntry,
  ChatTurnEntry,
} from "@dispatch/shared";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Pin,
} from "lucide-react";

import {
  LivePin,
  MediaFileBody,
} from "@/components/app/chat/chat-attachment-views";
import {
  type FeedContext,
  pinEntryVerb,
} from "@/components/app/chat/chat-entries";
import { usePinShortcuts } from "@/components/app/chat/pin-shortcut-context";
import type { AgentPin } from "@/components/app/types";
import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

/**
 * A feed entry the agent produced while a turn was running: a file it
 * shared, a pin it wrote, a message it sent to another agent. Each one is
 * still its own row on the wire; the feed folds it into the turn's post so
 * the work reads as one story instead of a post per side effect.
 */
export type FoldedEntry = ChatMediaEntry | ChatPinEntry | ChatAgentMessageEntry;

export function isFoldable(entry: ChatFeedEntry): entry is FoldedEntry {
  return (
    entry.type === "media" ||
    entry.type === "pin" ||
    (entry.type === "agent_message" && entry.direction === "out")
  );
}

/**
 * The window a turn owns: from its start to its end, open-ended while it
 * runs. `updatedAt` stands in for the end of a settled turn that never
 * recorded one (a turn cut by a restart).
 */
export function turnWindow(entry: ChatTurnEntry): {
  start: number;
  end: number;
} {
  const start = Date.parse(entry.trace.startedAt);
  const end = entry.settled
    ? Date.parse(entry.trace.endedAt ?? entry.updatedAt)
    : Number.POSITIVE_INFINITY;
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : Number.POSITIVE_INFINITY,
  };
}

/**
 * Fold every foldable entry into the turn whose window holds it. Entries
 * arrive in feed order, so the nearest turn above an entry is the only
 * candidate; anything that falls outside its window (a pin written between
 * turns, a file shared by a person's hand) stays a post of its own.
 */
export function foldAttachments(entries: readonly ChatFeedEntry[]): {
  entries: ChatFeedEntry[];
  folded: ReadonlyMap<string, FoldedEntry[]>;
} {
  const out: ChatFeedEntry[] = [];
  const folded = new Map<string, FoldedEntry[]>();
  let open: { id: string; window: { start: number; end: number } } | null =
    null;
  for (const entry of entries) {
    if (entry.type === "turn") {
      open = { id: entry.id, window: turnWindow(entry) };
      out.push(entry);
      continue;
    }
    if (open && isFoldable(entry)) {
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

function SentTo({ entry }: { entry: ChatAgentMessageEntry }): JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-xs"
      data-testid="chat-turn-sent-to"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          Sent to
        </span>
        <span className="font-medium text-foreground">
          {entry.recipientName}
        </span>
        {entry.delivered === null ? (
          <span
            className="inline-flex items-center gap-1 text-[11px]"
            title="Delivering to the recipient agent."
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Sending
          </span>
        ) : entry.delivered === false ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-destructive"
            title="The recipient agent wasn't running, so it never received this message."
          >
            <AlertTriangle className="h-3 w-3" />
            Not delivered
          </span>
        ) : null}
      </div>
      <div className="whitespace-pre-wrap break-words border-l-[3px] border-border pl-3 text-foreground/80">
        {entry.content}
      </div>
    </div>
  );
}

const CHIP_VALUE_MAX = 48;

function chipValue(pin: AgentPin): string {
  const first = pin.value.split(/[\n,]/, 1)[0]?.trim() ?? "";
  const shown =
    pin.type === "url" || pin.type === "pr"
      ? first.replace(/^https?:\/\//, "")
      : first;
  return shown.length > CHIP_VALUE_MAX
    ? `${shown.slice(0, CHIP_VALUE_MAX - 1)}…`
    : shown;
}

const CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs leading-none";

/**
 * A pin as one chip: its label, its first value, and one action — open
 * for a link, copy for anything else. Compact enough that several pins
 * from one turn read as a row, where the sidebar's card would stack into
 * a column of boxes taller than the answer they sit above.
 */
function PinChip({
  pin,
  testId,
}: {
  pin: AgentPin;
  testId: string;
}): JSX.Element {
  const [copied, copyText] = useCopyText();
  const value = chipValue(pin);
  const link = pin.type === "url" || pin.type === "pr";
  const body = (
    <>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {pin.label}
      </span>
      {value ? (
        <span
          className={cn(
            "min-w-0 truncate font-terminal",
            link ? "text-status-done" : "text-foreground"
          )}
        >
          {value}
        </span>
      ) : null}
      {link ? (
        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : copied ? (
        <Check className="h-3 w-3 shrink-0 text-status-working" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </>
  );
  return link ? (
    <a
      href={pin.value.split(/[\n,]/, 1)[0]?.trim()}
      target="_blank"
      rel="noreferrer"
      className={cn(CHIP_CLASS, "hover:border-foreground/30")}
      title={pin.value}
      data-testid={testId}
      data-pin-type={pin.type}
    >
      {body}
    </a>
  ) : (
    <button
      type="button"
      onClick={() => copyText(pin.value)}
      className={cn(CHIP_CLASS, "hover:border-foreground/30")}
      title={copied ? "Copied" : `Copy ${pin.label}`}
      data-testid={testId}
      data-pin-type={pin.type}
    >
      {body}
    </button>
  );
}

function PinLine({
  entry,
  ctx,
}: {
  entry: ChatPinEntry;
  ctx: FeedContext;
}): JSX.Element {
  const shortcuts = usePinShortcuts();
  const removed = entry.action === "deleted";
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-testid="chat-turn-pin"
      data-pin-action={entry.action}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Pin className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{pinEntryVerb(entry)}</span>
        {removed ? (
          <span className="min-w-0 truncate font-medium text-foreground/80">
            {entry.pins.map((pin) => pin.label).join(", ")}
          </span>
        ) : null}
      </div>
      {removed ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.pins.map((ref) => {
            const pin = shortcuts.pins.find((p) => p.id === ref.id);
            // A shortcut is a button already; a pin that has since been
            // deleted falls back to the "no longer available" line.
            if (!pin || pin.type === "shortcut") {
              return (
                <LivePin
                  key={ref.id}
                  pinId={ref.id}
                  label={ref.label}
                  ctx={ctx}
                  testId="chat-turn-pin-pin"
                />
              );
            }
            return (
              <PinChip key={ref.id} pin={pin} testId="chat-turn-pin-chip" />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What the agent produced along the way, in the order it produced it,
 * between the rail and the answer: the answer still reads last, and the
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
      className="mb-2 flex min-w-0 flex-col gap-2.5 font-sans"
      data-testid="chat-turn-attachments"
    >
      {items.map((item) => {
        switch (item.type) {
          case "media":
            return (
              <MediaFileBody
                key={item.id}
                entry={item}
                ctx={ctx}
                testId="chat-turn-media"
              />
            );
          case "pin":
            return <PinLine key={item.id} entry={item} ctx={ctx} />;
          case "agent_message":
            return <SentTo key={item.id} entry={item} />;
        }
      })}
    </div>
  );
});
