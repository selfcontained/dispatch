import { useState } from "react";
import type { HarnessQueuedPrompt } from "@dispatch/shared";
import { AnimatePresence, motion } from "framer-motion";

import {
  arrive,
  exitShrink,
  rowVariants,
} from "@/components/app/chat/turn/motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CHIP_CLASS =
  "inline-flex max-w-[240px] shrink-0 items-center truncate rounded-[2px] border border-border bg-background px-1.5 py-0.5 text-[10.5px] text-foreground/70";

const ACTION_CLASS =
  "h-6 px-1.5 text-[10.5px] pointer-coarse:h-11 pointer-coarse:px-3";

/**
 * How many rows stay on screen before the rest fold away. Two is what fits
 * above the composer without the queue becoming the pane.
 */
const VISIBLE_ROWS = 2;

function clip(text: string, max = 40): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One prompt waiting behind the running turn, on a single line.
 *
 * A queued message is a thing to act on, not a thing to read: the reader
 * already wrote it. So the row carries the controls and only as much text as
 * identifies which message it is, and the chevron opens the rest for the case
 * where it came from another agent and the reader has not seen it.
 */
export function QueuedPrompt({
  prompt,
  busy,
  onSendNow,
  onRemove,
}: {
  prompt: HarnessQueuedPrompt;
  /** An action on this prompt is in flight. */
  busy: boolean;
  onSendNow?: (id: string) => void;
  onRemove?: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const attachments = prompt.attachments ?? [];
  const excerpt = clip(prompt.text);
  return (
    <div
      data-testid="harness-queued"
      data-queued-id={prompt.id}
      // `group` drives the actions' reveal on hover. They stay in the DOM so
      // the row's width never changes as the pointer crosses it.
      className="group rounded-[3px] px-1 hover:bg-muted/40"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-label={open ? "Hide the full message" : `Show all of ${excerpt}`}
          data-testid="harness-queued-toggle"
          className="shrink-0 select-none px-0.5 text-[13px] font-bold leading-none text-muted-foreground/60 transition-transform hover:text-foreground pointer-coarse:px-2 pointer-coarse:py-2"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        >
          ›
        </button>
        {open ? null : (
          <p className="min-w-0 flex-1 truncate text-[12.5px] leading-[1.55] text-foreground/60">
            {prompt.text}
          </p>
        )}
        <span
          className="shrink-0 rounded-[2px] border border-status-waiting/40 bg-status-waiting/10 px-1.5 py-px text-[10px] uppercase tracking-wide text-status-waiting"
          data-testid="harness-queued-chip"
        >
          Queued
        </span>
        {prompt.senderName ? (
          <span className={CHIP_CLASS}>from {prompt.senderName}</span>
        ) : null}
        {attachments.length > 0 && !open ? (
          <span className={CHIP_CLASS}>{attachments.length} attached</span>
        ) : null}
        {/* Hidden until hover on a mouse, always there on touch, and always
            there once focused so the keyboard can reach them. */}
        <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onSendNow?.(prompt.id)}
            title="Interrupt the running turn and send this next"
            aria-label={`Send "${excerpt}" now, interrupting the current turn`}
            data-testid="harness-queued-send-now"
            className={cn(
              ACTION_CLASS,
              "text-status-working hover:text-status-working"
            )}
          >
            Send now
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onRemove?.(prompt.id)}
            title="Drop this message from the queue"
            aria-label={`Remove "${excerpt}" from the queue`}
            data-testid="harness-queued-remove"
            className={cn(
              ACTION_CLASS,
              "text-muted-foreground hover:text-foreground"
            )}
          >
            Remove
          </Button>
        </span>
      </div>
      {open ? (
        <div className="pb-1 pl-[18px] pr-1">
          <p className="whitespace-pre-wrap text-[12.5px] leading-[1.55] text-foreground/60">
            {prompt.text}
          </p>
          {attachments.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {attachments.map((a, i) => (
                <span key={`${a.type}:${i}`} className={CHIP_CLASS}>
                  {a.type === "file"
                    ? a.fileName
                    : a.type === "link" || a.type === "pr"
                      ? (a.title ?? a.url)
                      : a.type}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The whole queue as one block above the composer.
 *
 * It grows with every message the reader sends while a turn runs, and the
 * composer is below it, so an uncapped list walks the field off a short pane.
 * Past `VISIBLE_ROWS` the rest fold behind a count, and the opened list is
 * bounded and scrolls inside itself rather than pushing anything.
 */
export function QueuedStack({
  queued,
  busyId,
  onSendNow,
  onRemove,
}: {
  queued: HarnessQueuedPrompt[];
  /** The prompt with an action in flight, if any. */
  busyId: string | null;
  onSendNow?: (id: string) => void;
  onRemove?: (id: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (queued.length === 0) return null;

  const hidden = queued.length - VISIBLE_ROWS;
  const folded = hidden > 0 && !open;
  const shown = folded ? queued.slice(0, VISIBLE_ROWS) : queued;

  return (
    <div className="mb-1.5" data-testid="harness-queued-stack">
      <div
        className={cn(
          "min-w-0",
          // Only the opened long list scrolls. Below the fold the block is
          // two rows tall and a scroller would just add a stray gutter.
          open && "max-h-44 overflow-y-auto overscroll-contain"
        )}
      >
        <AnimatePresence initial={false}>
          {shown.map((prompt) => (
            <motion.div
              key={prompt.id}
              layout
              variants={rowVariants}
              initial="hidden"
              animate="shown"
              exit={exitShrink}
              transition={arrive()}
              style={{ overflow: "hidden" }}
            >
              <QueuedPrompt
                prompt={prompt}
                busy={busyId === prompt.id}
                onSendNow={onSendNow}
                onRemove={onRemove}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          data-testid="harness-queued-more"
          className="mt-0.5 px-1 text-[10.5px] text-muted-foreground hover:text-foreground pointer-coarse:py-2"
        >
          {open ? "Show fewer" : `+${hidden} more queued`}
        </button>
      ) : null}
    </div>
  );
}
