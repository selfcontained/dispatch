import { memo, useMemo } from "react";
import type {
  Block,
  ChatTurnEntry,
  ChatTurnStep,
  StreamBlockEntry,
  StreamEntry,
} from "@dispatch/shared";
import {
  BlockView,
  type FeedContext,
  POST_BODY_MEASURE,
} from "@/components/app/chat/chat-entries";
import { cn } from "@/lib/utils";

import { ActivityBlock } from "./activity-block";
import { AutoHeight } from "./auto-height";
import type { Step, Trace, Turn } from "./contracts";
import { parseDispatchNotice, PromptLine } from "./prompt-line";
import { turnLabelFromSteps } from "./registry";
import { type ResultRetry, ResultTurn } from "./result-turn";
import { type FoldedEntry, TurnAttachments } from "./turn-attachments";

/** A turn prompt is never a question, so its post never offers an answer. */
const NO_ANSWER = (): void => undefined;
const NO_FOLDED: readonly FoldedEntry[] = [];

/** A feed row that is a turn: the agent's answer block with its turn attached. */
export function isTurnEntry(
  entry: StreamEntry
): entry is StreamBlockEntry & { block: Block & { turn: ChatTurnEntry } } {
  return entry.type === "block" && entry.block.turn !== undefined;
}

/** One trace step as the rail's model carries it: ISO times become epoch ms. */
export function turnStep(step: ChatTurnStep): Step {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
    ...(step.children?.length ? { children: step.children.map(turnStep) } : {}),
  };
}

export function turnTrace(turn: ChatTurnEntry): Trace {
  return {
    startedAt: Date.parse(turn.trace.startedAt),
    ...(turn.trace.endedAt ? { endedAt: Date.parse(turn.trace.endedAt) } : {}),
    ...(turn.trace.finalResult
      ? { finalResult: turn.trace.finalResult }
      : {}),
    steps: turn.trace.steps.map(turnStep),
  };
}

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
  return {
    id: `${block.id}:result`,
    role: "assistant",
    content: turn.settled ? block.text : (turn.result?.text ?? ""),
    timestamp: Date.parse(turn.trace.endedAt ?? block.createdAt),
    trace,
    ...(turn.error
      ? { error: { code: "turn_failed", message: turn.error } }
      : {}),
  };
}

/** A Dispatch-injected prompt as the notice line's model. */
export function promptTurnModel(turn: ChatTurnEntry): Turn {
  return {
    id: `${turn.id}:prompt`,
    role: "user",
    content: turn.prompt.text,
    timestamp: Date.parse(turn.at),
    extra: { source: turn.prompt.source },
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
 * line that opens into the step rail on click. A prompt Dispatch injected
 * (a job, a nudge) has no post of its own in the column, so its notice
 * line sits above the answer. The message lands whole when the turn
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
  // The folded rail reads "<verb>, 12 steps, 1m 4s"; the verb is derived
  // from the steps: "edited turns.ts", "ran pnpm test", "read 3 files".
  const foldLabel = useMemo(
    () => turnLabelFromSteps(trace.steps),
    [trace.steps]
  );
  const notice = useMemo(
    () => parseDispatchNotice(turn.prompt.text, turn.prompt.source),
    [turn.prompt.source, turn.prompt.text]
  );
  const promptTurn = useMemo(() => promptTurnModel(turn), [turn]);
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
      {notice ? (
        <div className="mb-1" data-testid="chat-turn-notice">
          <PromptLine turn={promptTurn} />
        </div>
      ) : null}
      {/* One measured body for the rail and the answer: every size change
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
        {showsRail(trace, result) || !turn.settled ? (
          <div className={cn(result.content && "mt-2")}>
            <ActivityBlock trace={trace} label={foldLabel} />
          </div>
        ) : null}
      </AutoHeight>
    </div>
  );
}

/**
 * The activity line is there from the turn's first tick ("thinking") and
 * stays through settle once any step ran. A turn that only ever answered
 * has nothing to fold, so its line steps aside as soon as the answer
 * starts and never comes back.
 */
export function showsRail(trace: Trace, result: Turn): boolean {
  if (trace.steps.length > 0) return true;
  return trace.endedAt == null && result.content.length === 0;
}

export const TurnEntryView = memo(TurnEntryViewImpl);
