/**
 * Emoji reactions on chat posts: the picker a post offers as an action, and
 * the row of chips under a post. Presentational — they take a post's
 * reactions and a toggle callback, and read nothing else from the feed.
 * Also home to the post action button styles the picker shares with the
 * copy button. Split out of chat-entries.tsx, which composes them into posts.
 */
import { useEffect, useRef, useState } from "react";
import type { ChatReaction } from "@dispatch/shared";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AlertTriangle, SmilePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { isOptimisticReaction } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

/**
 * A post action button: hidden until the post is hovered or the button is
 * focused, always shown on touch, and a real tap target there.
 */
export const POST_ACTION_BUTTON = cn(
  "h-7 w-7 p-0 hover:bg-transparent",
  "max-sm:h-11 max-sm:w-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
  "max-sm:opacity-100 [@media(pointer:coarse)]:opacity-100"
);

/** The chip-like face every post action button draws. */
export const POST_ACTION_FACE =
  "flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/90 shadow-sm";

/** The emoji the reaction picker offers. */
const REACTION_EMOJI: readonly string[] = [
  "👍",
  "👎",
  "❤️",
  "🎉",
  "😂",
  "🤔",
  "👀",
  "🚀",
  "✅",
  "❌",
  "🙏",
  "🔥",
];

/**
 * The post action that opens the emoji picker. Picking an emoji the message
 * already carries takes it back off, as clicking its chip does.
 */
export function ReactionPickerButton({
  reactions,
  onToggle,
  disabled = false,
}: {
  reactions: readonly ChatReaction[];
  onToggle: (emoji: string, remove: boolean) => void;
  /**
   * Nothing can reach the agent right now (stopped, loading, errored). The
   * button stays in place, greyed, so it does not vanish from every post in
   * the history at once — the same way question options disable.
   */
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  if (disabled) {
    // A disabled button takes no pointer events, so the tooltip hangs on a
    // wrapper.
    return (
      <span
        className="inline-flex"
        title="Reactions go to the agent, which can't receive them right now."
        data-testid="chat-add-reaction-disabled"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={POST_ACTION_BUTTON}
          aria-label="Add reaction (unavailable while the agent can't receive messages)"
          disabled
          data-testid="chat-add-reaction"
        >
          <span className={POST_ACTION_FACE}>
            <SmilePlus className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </Button>
      </span>
    );
  }
  const reacted = new Set(
    reactions
      .filter((reaction) => reaction.authorKind === "user")
      .map((reaction) => reaction.emoji)
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Stays up while its picker is open, even once the pointer leaves.
          className={cn(POST_ACTION_BUTTON, "data-[state=open]:opacity-100")}
          title="Add reaction"
          aria-label="Add reaction"
          data-testid="chat-add-reaction"
        >
          <span className={POST_ACTION_FACE}>
            <SmilePlus className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // The shared popover's enter/exit classes need a plugin this app does
        // not load, so the picker brings its own; Radix waits for the exit
        // animation before it unmounts.
        className={cn(
          "w-auto origin-[var(--radix-popover-content-transform-origin)] p-1.5",
          "data-[state=open]:animate-reaction-picker-in data-[state=closed]:animate-reaction-picker-out",
          "motion-reduce:!animate-none"
        )}
        data-testid="chat-reaction-picker"
      >
        <div
          className="grid grid-cols-6 gap-0.5"
          role="group"
          aria-label="Reactions"
        >
          {REACTION_EMOJI.map((emoji, index) => {
            const selected = reacted.has(emoji);
            return (
              <button
                key={emoji}
                type="button"
                className={cn(
                  "flex h-8 w-8 animate-reaction-emoji-in items-center justify-center rounded-md text-lg leading-none transition-[background-color,transform] hover:scale-110 hover:bg-muted motion-reduce:animate-none motion-reduce:hover:scale-100",
                  "max-sm:h-11 max-sm:w-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
                  selected && "bg-primary/15 hover:bg-primary/25"
                )}
                aria-label={
                  selected ? `Remove ${emoji} reaction` : `React with ${emoji}`
                }
                aria-pressed={selected}
                data-testid="chat-reaction-option"
                data-emoji={emoji}
                style={{ animationDelay: `${40 + index * 14}ms` }}
                onClick={() => {
                  setOpen(false);
                  onToggle(emoji, selected);
                }}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function userReactionTitle(reaction: ChatReaction, removable: boolean): string {
  const state =
    reaction.delivered === null
      ? "Sending your reaction to the agent…"
      : reaction.delivered
        ? "Sent to the agent."
        : "Not delivered — the agent had no terminal to receive it.";
  return removable ? `${state} Click to remove.` : state;
}

const REACTION_CHIP =
  "inline-flex h-6 items-center rounded-full border px-2 text-sm leading-none transition-colors max-sm:h-8 max-sm:px-2.5 [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:px-2.5";

/** How a chip arrives and leaves: a quick pop, and neighbours slide over. */
const CHIP_MOTION = {
  layout: true,
  initial: { opacity: 0, scale: 0.5 },
  animate: { opacity: 1, scale: 1 },
  // A leaving chip stays on screen for its exit; it must not take a second
  // click meanwhile.
  exit: { opacity: 0, scale: 0.5, pointerEvents: "none" },
  transition: { type: "spring", stiffness: 520, damping: 28, mass: 0.6 },
} as const;

/**
 * The reactions under a post, one chip per author and emoji. Each side
 * reacts to the other's posts, so an agent post carries the user's
 * reactions and a user post the agent's.
 *
 * The user's own chips are buttons: clicking one takes the reaction back
 * off, as in Slack — no × on the chip, which would read as deleting
 * something rather than un-reacting. That only changes the chip, since the
 * agent was told when it was added. A chip whose add is
 * still in flight cannot be removed yet. A pending delivery is dimmed and an
 * undelivered one marked, mirroring a user post's delivery state. The
 * agent's chips are plain labels — only the agent can take its reaction back.
 *
 * Chips pop in and out as reactions come and go — live, not on first paint:
 * reactions already there when the post renders simply show. When the last
 * chip goes, the row waits for it to pop out before collapsing.
 */
export function ReactionBar({
  reactions,
  agentName,
  onToggle,
}: {
  reactions: readonly ChatReaction[];
  agentName: string;
  onToggle?: (emoji: string, remove: boolean) => void;
}): JSX.Element {
  // False only for this post's first paint; a bar that appears later (the
  // first reaction arriving) animates its first chip in too.
  const paintedRef = useRef(false);
  useEffect(() => {
    paintedRef.current = true;
  }, []);

  // The row outlives its last reaction by that chip's exit animation: the
  // chips' own presence says when it is done, and only then does the row
  // collapse. Unmounting the row with the last reaction would freeze the
  // chip in place and play only the collapse.
  const hasReactions = reactions.length > 0;
  const [showRow, setShowRow] = useState(hasReactions);
  if (hasReactions && !showRow) setShowRow(true);
  const hasReactionsRef = useRef(hasReactions);
  hasReactionsRef.current = hasReactions;
  const lingering = showRow && !hasReactions;

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence initial={false}>
        {showRow ? (
          <motion.div
            key="reactions"
            className={cn(
              "flex flex-wrap items-center gap-1",
              // The leaving chip is popped out of the flow; hold its line so
              // the post does not shrink under it before the row collapses.
              lingering &&
                "min-h-6 max-sm:min-h-8 [@media(pointer:coarse)]:min-h-8"
            )}
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 6 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            data-testid="chat-reactions"
          >
            <AnimatePresence
              initial={paintedRef.current}
              mode="popLayout"
              onExitComplete={() => {
                if (!hasReactionsRef.current) setShowRow(false);
              }}
            >
              {reactions.map((reaction) => {
                if (reaction.authorKind === "agent") {
                  return (
                    <motion.span
                      key={`agent:${reaction.emoji}`}
                      {...CHIP_MOTION}
                      className={cn(REACTION_CHIP, "border-border bg-muted/40")}
                      title={`${agentName} reacted ${reaction.emoji}`}
                      aria-label={`${agentName} reacted ${reaction.emoji}`}
                      role="img"
                      data-testid="chat-reaction"
                      data-author-kind="agent"
                      data-emoji={reaction.emoji}
                    >
                      {reaction.emoji}
                    </motion.span>
                  );
                }
                const inFlight = isOptimisticReaction(reaction);
                const removable = onToggle !== undefined && !inFlight;
                return (
                  <motion.button
                    key={`user:${reaction.emoji}`}
                    {...CHIP_MOTION}
                    // Motion owns the chip's opacity, so a pending chip's dim
                    // is animated here rather than set with a class.
                    animate={{
                      opacity: reaction.delivered === null ? 0.6 : 1,
                      scale: 1,
                    }}
                    type="button"
                    className={cn(
                      REACTION_CHIP,
                      reaction.delivered === false
                        ? "border-destructive/50 bg-destructive/10 hover:bg-destructive/15"
                        : "border-primary/40 bg-primary/10 hover:bg-primary/20",
                      !removable && "cursor-default"
                    )}
                    title={userReactionTitle(reaction, removable)}
                    aria-label={
                      removable
                        ? `Remove your ${reaction.emoji} reaction`
                        : `Your ${reaction.emoji} reaction`
                    }
                    disabled={!removable}
                    data-testid="chat-reaction"
                    data-author-kind="user"
                    data-emoji={reaction.emoji}
                    data-delivered={String(reaction.delivered)}
                    onClick={() => onToggle?.(reaction.emoji, true)}
                  >
                    <span aria-hidden="true">{reaction.emoji}</span>
                    {reaction.delivered === false ? (
                      <AlertTriangle
                        className="ml-1 h-3 w-3 text-destructive"
                        aria-hidden="true"
                      />
                    ) : null}
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </MotionConfig>
  );
}
