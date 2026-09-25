import { memo, type ReactNode, useMemo } from "react";
import type { Block, ChatTurnEntry } from "@dispatch/shared";
import {
  BlockView,
  type FeedContext,
  POST_BODY_MEASURE,
} from "@/components/app/chat/chat-entries";
import { cn } from "@/lib/utils";

import { ActivityBlock } from "./activity-block";
import { AutoHeight } from "./auto-height";
import type { Trace, Turn } from "./contracts";
import { turnLabelFromSteps } from "./registry";
import { turnTrace } from "./trace";
import { type ResultRetry, ResultTurn } from "./result-turn";
import { type FoldedEntry, TurnAttachments } from "./turn-attachments";

/** A turn prompt is never a question, so its post never offers an answer. */
const NO_ANSWER = (): void => undefined;
const NO_FOLDED: readonly FoldedEntry[] = [];

/**
 * The turn's answer as the result renderer's model. The text is the
 * block's once the turn settled (the server writes the answer there); a
 * running turn's text, when any, is what the turn has so far.
 */
export function resultTurnModel(
  block: Block,
  turn: ChatTurnEntry,
  trace: Trace
): Turn {
  const content = turn.settled ? block.text : (turn.result?.text ?? "");
  const lead = turn.result?.lead;
  return {
    id: `${block.id}:result`,
    role: "assistant",
    content,
    // Only a lead the answer still opens with splits it.
    ...(lead && content.startsWith(lead) ? { lead } : {}),
    timestamp: Date.parse(turn.trace.endedAt ?? block.createdAt),
    trace,
    ...(turn.error
      ? { error: { code: "turn_failed", message: turn.error } }
      : {}),
  };
}

export type TurnEntryViewProps = {
  block: Block;
  turn: ChatTurnEntry;
  grouped: boolean;
  /** A hairline above: this entry follows another directly. */
  rule?: boolean;
  ctx: FeedContext;
  /** Files, pins and posts to other agents the agent produced during this turn. */
  folded?: readonly FoldedEntry[];
};

/**
 * A turn as a feed row: the agent's answer block, whoever ran it. A child's
 * turn is a post under the child's name and seat, its steps folded under
 * the answer like the parent's; the "show child agents" filter is where a
 * reader turns their traffic off.
 */
function TurnEntryViewImpl({
  block,
  turn,
  grouped,
  rule,
  ctx,
  folded,
}: TurnEntryViewProps): JSX.Element {
  return (
    <BlockView
      block={block.turn === turn ? block : { ...block, turn }}
      grouped={grouped}
      rule={rule}
      ctx={ctx}
      answering={false}
      answersDisabled
      onAnswer={NO_ANSWER}
      folded={folded}
    />
  );
}

/**
 * The body of a turn's block: the answer, and under it one quiet activity
 * line that opens into the step list on click. An internal prompt leaves only
 * the agent's turn. The message lands whole when the turn
 * settles, as a chat message does; nothing streams into the column. Until
 * then the block is its header and one activity line.
 */
export function TurnAnswer({
  block,
  turn,
  ctx,
  folded = NO_FOLDED,
}: {
  block: Block;
  turn: ChatTurnEntry;
  ctx: FeedContext;
  folded?: readonly FoldedEntry[];
}): JSX.Element {
  const trace = useMemo(() => turnTrace(turn), [turn]);
  const result = useMemo(
    () => resultTurnModel(block, turn, trace),
    [block, turn, trace]
  );
  // The folded step list reads "<verb>, 12 steps, 1m 4s"; the verb is derived
  // from the steps: "edited turns.ts", "ran pnpm test", "read 3 files".
  const foldLabel = useMemo(
    () => turnLabelFromSteps(trace.steps),
    [trace.steps]
  );
  const onRetryTurn = ctx.onRetryTurn;
  const retryPending = ctx.retrying?.has(block.id) ?? false;
  const retry = useMemo<ResultRetry | undefined>(
    () =>
      turn.retry
        ? {
            state: turn.retry,
            ...(onRetryTurn ? { onRetry: () => onRetryTurn(block.id) } : {}),
            pending: retryPending,
          }
        : undefined,
    [turn.retry, onRetryTurn, retryPending, block.id]
  );
  return (
    <div
      className={cn(
        POST_BODY_MEASURE,
        "w-full min-w-0 font-terminal [overflow-wrap:anywhere]"
      )}
      data-testid="chat-turn"
      data-turn-id={block.id}
      data-settled={turn.settled ? "true" : undefined}
    >
      {/* One measured body for the steps and the answer: every size change
          inside it eases instead of snapping, so the feed above glides
          rather than jumps while it follows the bottom. */}
      <AutoHeight data-testid="chat-turn-body">
        {turn.settled ? (
          <ResultTurn turn={result} retry={retry} />
        ) : result.content ? (
          // The reply as it is being written: the agent's own words, in the
          // quiet tone of something still in progress, so a long turn reads
          // as it happens rather than landing whole at the end. It takes its
          // final styling when the turn settles and this becomes the answer.
          <div
            className="whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]"
            data-testid="chat-turn-live-text"
          >
            {result.content}
          </div>
        ) : null}
        <TurnAttachments items={folded} ctx={ctx} />
        {showsActivityLine(trace, result) || !turn.settled ? (
          <div className={cn(result.content && "mt-2")}>
            <ActivityBlock
              trace={trace}
              label={foldLabel}
              details={
                turn.trace.detailsOmitted && ctx.rootId
                  ? { rootId: ctx.rootId, blockId: block.id }
                  : undefined
              }
            />
          </div>
        ) : null}
      </AutoHeight>
    </div>
  );
}

/**
 * A running turn that has nothing to say yet: no words of its reply and
 * nothing it produced. It is presence, not a message, so the
 * feed shows it as a status line rather than a post with a header.
 */
export function isPendingTurn(
  block: Block,
  turn: ChatTurnEntry,
  folded: readonly FoldedEntry[] | undefined
): boolean {
  if (turn.settled || turn.error) return false;
  if (turn.result?.text) return false;
  if (folded?.length || block.attachments?.length) return false;
  return true;
}

/**
 * The pending turn's one line: who is working and what they are doing now,
 * the live activity summary in the author's place. The step rail opens
 * under it as it does in the full post.
 */
export function PendingTurnLine({
  block,
  turn,
  name,
  avatar,
}: {
  block: Block;
  turn: ChatTurnEntry;
  name: string;
  avatar: ReactNode;
}): JSX.Element {
  const trace = useMemo(() => turnTrace(turn), [turn]);
  const foldLabel = useMemo(
    () => turnLabelFromSteps(trace.steps),
    [trace.steps]
  );
  return (
    <div
      className="mt-1 flex min-w-0 max-w-full gap-3 px-4 py-1 animate-chat-enter motion-reduce:animate-none"
      data-testid="chat-pending-turn"
      data-block-id={block.id}
      data-turn-id={block.id}
    >
      <div className="flex h-[22px] w-8 shrink-0 items-center justify-end">
        {avatar}
      </div>
      <div
        className={cn(
          POST_BODY_MEASURE,
          "flex min-w-0 flex-1 flex-col font-terminal"
        )}
      >
        <span
          className="max-w-full truncate pt-[3px] text-[11.5px] font-medium text-foreground/80"
          data-testid="chat-pending-turn-author"
        >
          {name}
        </span>
        <ActivityBlock trace={trace} label={foldLabel} />
      </div>
    </div>
  );
}

/**
 * The activity line is there from the turn's first tick ("thinking") and
 * stays through settle once any step ran. A turn that only ever answered
 * has nothing to fold, so its line steps aside as soon as the answer
 * starts and never comes back.
 */
export function showsActivityLine(trace: Trace, result: Turn): boolean {
  if (trace.steps.length > 0) return true;
  return trace.endedAt == null && result.content.length === 0;
}

export const TurnEntryView = memo(TurnEntryViewImpl);
