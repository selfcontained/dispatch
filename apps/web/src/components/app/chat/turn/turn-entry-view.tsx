import { memo, useMemo } from "react";
import type {
  Block,
  ChatTurnEntry,
  ChatTurnStep,
  StreamBlockEntry,
  StreamEntry,
} from "@dispatch/shared";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";

import { AgentRelationBadge } from "@/components/app/agent-relation-badge";
import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import {
  agentDisplayName,
  BlockView,
  type FeedContext,
  peerAuthor,
  POST_BODY_MEASURE,
} from "@/components/app/chat/chat-entries";
import { cn } from "@/lib/utils";

import { useChatRowState } from "../chat-row-state";
import { ActivityBlock, TurnGlyph, turnSummary } from "./activity-block";
import { AutoHeight } from "./auto-height";
import type { Step, Trace, Turn } from "./contracts";
import { formatStepDuration } from "./format";
import { parseDispatchNotice, PromptLine } from "./prompt-line";
import { turnLabelFromSteps } from "./registry";
import { ResultTurn } from "./result-turn";
import { type FoldedEntry, TurnAttachments } from "./turn-attachments";
import { useStreamTicker } from "./use-stream-ticker";

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
 * A turn as a feed row: the agent's answer block. The page agent's turns
 * render as posts (the block view draws the answer with its rail); a turn
 * run by another agent than the page's folds to one row under that
 * agent's name (see {@link ChildTurnView}).
 */
function TurnEntryViewImpl(props: TurnEntryViewProps): JSX.Element {
  const { block, turn, ctx, grouped, rule, folded } = props;
  if (block.author.kind === "agent" && block.author.agentId !== ctx.agentId) {
    return <ChildTurnView {...props} />;
  }
  return (
    <BlockView
      block={block.turn === turn ? block : { ...block, turn }}
      held={false}
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
 * A turn run by an agent under this one, folded to one row: the child's
 * icon and name, then what the rail's own summary row would say of the
 * turn (its verb, step count and time). In the stream the row opens the
 * turn as a page in the drawer; where there is no drawer to open, it
 * unfolds to the child's answer in full.
 */
export function ChildTurnView({
  block,
  turn,
  rule = false,
  ctx,
  folded = NO_FOLDED,
}: TurnEntryViewProps): JSX.Element {
  const [open, setOpen] = useChatRowState<boolean>("child-turn-open", false);
  const trace = useMemo(() => turnTrace(turn), [turn]);
  const label = useMemo(() => turnLabelFromSteps(trace.steps), [trace.steps]);
  const done = trace.endedAt != null;
  // Re-render on the shared tick while the turn runs, so the time counts.
  useStreamTicker(!done);
  const summary = turnSummary(trace, label);
  const agentId = block.author.kind === "agent" ? block.author.agentId : "";
  const name = agentDisplayName(agentId, ctx);
  const author = peerAuthor(agentId, name, ctx);
  const duration = formatStepDuration(summary.ms);
  return (
    <div
      data-testid="chat-child-turn"
      data-turn-id={block.id}
      data-agent-id={agentId}
      data-open={open ? "true" : "false"}
      data-settled={turn.settled ? "true" : undefined}
      className={cn(rule && "border-t border-border/40")}
    >
      <button
        type="button"
        onClick={() =>
          ctx.onOpenTurn ? ctx.onOpenTurn(block.id) : setOpen(!open)
        }
        aria-expanded={ctx.onOpenTurn ? undefined : open}
        aria-label={`${name}, ${summary.verb}, ${summary.steps}, ${duration}, ${
          ctx.onOpenTurn ? "open" : open ? "collapse" : "expand"
        } turn`}
        data-testid="chat-child-turn-summary"
        className={cn(
          "group flex w-full min-w-0 items-center gap-3 px-4 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/30",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50",
          open ? "mt-3" : "mt-1"
        )}
      >
        <span className="flex w-8 shrink-0 justify-end">
          {author.seat !== undefined ? (
            <AgentSeatBadge seat={author.seat} name={name} size="sm" />
          ) : (
            <span
              className="flex h-5 w-5 items-center justify-center rounded border border-border bg-muted/50 text-foreground/80"
              aria-hidden="true"
            >
              <Bot className="h-3 w-3" />
            </span>
          )}
        </span>
        <span
          className="flex w-3 shrink-0 justify-center leading-none"
          aria-hidden="true"
        >
          <TurnGlyph summary={summary} />
        </span>
        <span
          className="min-w-0 max-w-[40%] truncate font-semibold text-foreground"
          data-testid="chat-child-turn-agent"
        >
          {name}
        </span>
        {author.relation && author.relation !== "agent" ? (
          <AgentRelationBadge relation={author.relation} />
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate",
            summary.done ? "text-foreground" : "font-medium text-status-working"
          )}
          title={summary.verb}
        >
          {summary.verb}
        </span>
        {summary.thinking ? null : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {summary.steps} · {duration}
          </span>
        )}
        <span
          aria-hidden="true"
          className="ml-auto shrink-0 text-[9px] text-muted-foreground/70"
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>
      </button>
      {open ? (
        <BlockView
          block={block.turn === turn ? block : { ...block, turn }}
          held={false}
          grouped={false}
          ctx={ctx}
          answering={false}
          answersDisabled
          onAnswer={NO_ANSWER}
          folded={folded}
        />
      ) : null}
    </div>
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
        {turn.settled ? <ResultTurn turn={result} /> : null}
        <TurnAttachments items={folded} ctx={ctx} />
        {showsRail(trace, result) || !turn.settled ? (
          <div className={cn(turn.settled && result.content && "mt-2")}>
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
