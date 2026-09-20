import { memo, useMemo } from "react";
import type { Block, ChatTurnEntry, ChatTurnStep } from "@dispatch/shared";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";

import { AgentRelationBadge } from "@/components/app/agent-relation-badge";
import {
  agentAuthor,
  agentDisplayName,
  BlockView,
  type FeedContext,
  MessageCopyButton,
  peerAuthor,
  Post,
  POST_BODY_MEASURE,
  type PostAuthor,
  SIDE_POST_INDENT,
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

export function turnTrace(entry: ChatTurnEntry): Trace {
  return {
    startedAt: Date.parse(entry.trace.startedAt),
    ...(entry.trace.endedAt
      ? { endedAt: Date.parse(entry.trace.endedAt) }
      : {}),
    ...(entry.trace.finalResult
      ? { finalResult: entry.trace.finalResult }
      : {}),
    steps: entry.trace.steps.map(turnStep),
  };
}

/**
 * The prompt as one of the user's posts. The attachments pass through
 * untouched, so the feed's own image and file rendering (and its lightbox)
 * handles them rather than a second renderer. `updatedAt` deliberately
 * mirrors `at`: the post does not change while the turn below it grows.
 */
export function promptBlock(entry: ChatTurnEntry): Block {
  return {
    id: entry.prompt.chatMessageId ?? `${entry.id}:prompt`,
    streamId: entry.agentId,
    author: { kind: "user" },
    toAgentId: entry.agentId,
    threadId: null,
    replyTo: null,
    kind: "text",
    data: null,
    state: null,
    text: entry.prompt.text,
    attachments: entry.prompt.attachments,
    // The prompt reached the engine: it opened this turn.
    delivered: true,
    readAt: null,
    ...(entry.prompt.source === "launch" ? { origin: "launch" as const } : {}),
    createdAt: entry.at,
    updatedAt: entry.at,
  };
}

/** The turn's answer as the result renderer's model. */
export function resultTurnModel(entry: ChatTurnEntry, trace: Trace): Turn {
  return {
    id: `${entry.id}:result`,
    role: "assistant",
    content: entry.result?.text ?? "",
    timestamp: Date.parse(entry.trace.endedAt ?? entry.at),
    trace,
    ...(entry.error
      ? { error: { code: "turn_failed", message: entry.error } }
      : {}),
  };
}

/** A Dispatch-injected prompt as the notice line's model. */
export function promptTurnModel(entry: ChatTurnEntry): Turn {
  return {
    id: `${entry.id}:prompt`,
    role: "user",
    content: entry.prompt.text,
    timestamp: Date.parse(entry.at),
    extra: { source: entry.prompt.source },
  };
}

export type TurnEntryViewProps = {
  entry: ChatTurnEntry;
  /**
   * Always false: a turn carries a user post and an agent post inside one
   * entry, so nothing outside it groups with either half. The prop is here
   * to match every other entry view's shape.
   */
  grouped: boolean;
  /** A hairline above the prompt post: this entry follows another directly. */
  rule?: boolean;
  ctx: FeedContext;
  /** Files, pins and posts to other agents the agent produced during this turn. */
  folded?: readonly FoldedEntry[];
};

/**
 * One harness turn as a feed entry: the prompt that opened it, then the
 * agent's post: its text, and under the text one quiet activity line that
 * opens into the step rail on click. No scroll follow of its own: the feed
 * owns that, keyed on `entryGrowthKey`.
 *
 * The feed is the root agent's stream, which carries the turns of every
 * agent in its tree: a turn run by another agent than the page's folds to
 * one row under that agent's name (see {@link ChildTurnView}).
 */
function TurnEntryViewImpl(props: TurnEntryViewProps): JSX.Element {
  const { entry, ctx } = props;
  if (entry.agentId !== ctx.agentId) return <ChildTurnView {...props} />;
  return <TurnBody {...props} author={agentAuthor(ctx, "Agent")} />;
}

/**
 * A turn run by an agent under this one, folded to one row: the child's
 * icon and name, then what the rail's own summary row would say of the
 * turn (its verb, step count and time). Open, it is the child's turn in
 * full, its answer posted under the child's name.
 */
function ChildTurnView({
  entry,
  rule = false,
  ctx,
  folded = NO_FOLDED,
}: TurnEntryViewProps): JSX.Element {
  const [open, setOpen] = useChatRowState<boolean>("child-turn-open", false);
  const trace = useMemo(() => turnTrace(entry), [entry]);
  const label = useMemo(() => turnLabelFromSteps(trace.steps), [trace.steps]);
  const done = trace.endedAt != null;
  // Re-render on the shared tick while the turn runs, so the time counts.
  useStreamTicker(!done);
  const summary = turnSummary(trace, label);
  const name = agentDisplayName(entry.agentId, ctx);
  const author = peerAuthor(entry.agentId, name, ctx);
  const duration = formatStepDuration(summary.ms);
  return (
    <div
      data-testid="chat-child-turn"
      data-turn-id={entry.id}
      data-agent-id={entry.agentId}
      data-open={open ? "true" : "false"}
      data-settled={entry.settled ? "true" : undefined}
      className={cn(rule && "border-t border-border/40")}
    >
      <button
        type="button"
        // In the stream the row opens the turn as a page in the drawer; where
        // there is no drawer to open (the drawer's own pages), it unfolds.
        onClick={() =>
          ctx.onOpenTurn ? ctx.onOpenTurn(entry.id) : setOpen(!open)
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
          <span
            className="flex h-5 w-5 items-center justify-center rounded border border-border bg-muted/50 text-foreground/80"
            aria-hidden="true"
          >
            <Bot className="h-3 w-3" />
          </span>
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
        <TurnBody
          entry={entry}
          grouped={false}
          rule={false}
          ctx={ctx}
          folded={folded}
          author={author}
          // What opened a child's turn is already in the column: its
          // launch block, or a post from its parent.
          hidePrompt
        />
      ) : null}
    </div>
  );
}

/** The turn in full: prompt post, rail, folded side effects, answer. */
function TurnBody({
  entry,
  rule = false,
  ctx,
  folded = NO_FOLDED,
  author,
  hidePrompt = false,
}: TurnEntryViewProps & {
  author: PostAuthor;
  hidePrompt?: boolean;
}): JSX.Element {
  const trace = useMemo(() => turnTrace(entry), [entry]);
  const result = useMemo(() => resultTurnModel(entry, trace), [entry, trace]);
  // The folded rail reads "<verb>, 12 steps, 1m 4s"; the verb is derived
  // from the steps: "edited turns.ts", "ran pnpm test", "read 3 files".
  const foldLabel = useMemo(
    () => turnLabelFromSteps(trace.steps),
    [trace.steps]
  );
  const notice = useMemo(
    () => parseDispatchNotice(entry.prompt.text, entry.prompt.source),
    [entry.prompt.source, entry.prompt.text]
  );
  /**
   * A post from another agent is already a feed row of its own (the block
   * it posted, under its name and with its relation badge), written when it
   * was sent rather than when its turn ran. Rendering it here too showed the
   * same words twice, in two cards that did not even match, and minutes
   * apart whenever the prompt had queued.
   */
  // A reply in a thread (an answer to a question) is already shown by the
  // block it answers, and a block of another kind (a review left by hand)
  // is a row of its own, so the turn either opened draws no prompt post.
  const showsPrompt =
    !hidePrompt &&
    entry.prompt.source !== "agent" &&
    !entry.prompt.threadId &&
    (entry.prompt.kind ?? "text") === "text";
  const promptTurn = useMemo(() => promptTurnModel(entry), [entry]);
  const prompt = useMemo(() => promptBlock(entry), [entry]);
  return (
    <div
      data-testid="chat-turn"
      data-turn-id={entry.id}
      data-settled={entry.settled ? "true" : undefined}
    >
      {notice ? (
        <div
          className={cn("pt-2 pr-4", SIDE_POST_INDENT, POST_BODY_MEASURE)}
          data-testid="chat-turn-notice"
        >
          <PromptLine turn={promptTurn} />
        </div>
      ) : showsPrompt ? (
        <BlockView
          block={prompt}
          held={false}
          grouped={false}
          rule={rule}
          ctx={ctx}
          answering={false}
          answersDisabled
          onAnswer={NO_ANSWER}
        />
      ) : null}
      <div className="mt-3">
        <Post
          author={author}
          at={entry.at}
          grouped={false}
          // The answer is the half a reader wants to lift out, and the prompt
          // above it has had a copy button all along.
          action={
            entry.result?.text ? (
              <MessageCopyButton text={entry.result.text} />
            ) : undefined
          }
          data-testid="chat-turn-result"
        >
          <div
            className={cn(
              POST_BODY_MEASURE,
              "w-full min-w-0 font-terminal [overflow-wrap:anywhere]"
            )}
          >
            {/* One measured body for the rail and the answer: every size
                change inside it — a row landing, the thinking row coming and
                going, text streaming in, the rail folding on settle — eases
                instead of snapping, so the feed above glides rather than
                jumps while it follows the bottom. */}
            <AutoHeight data-testid="chat-turn-body">
              {/* The message lands whole when the turn settles, as a chat
                  message does; nothing streams into the column. Until then
                  the post is its header and one activity line. The work
                  that produced the message is a footnote under the text. */}
              {entry.settled ? <ResultTurn turn={result} /> : null}
              <TurnAttachments items={folded} ctx={ctx} />
              {showsRail(trace, result) || !entry.settled ? (
                <div className={cn(entry.settled && result.content && "mt-2")}>
                  <ActivityBlock trace={trace} label={foldLabel} />
                </div>
              ) : null}
            </AutoHeight>
          </div>
        </Post>
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
export function showsRail(trace: Trace, result: Turn): boolean {
  if (trace.steps.length > 0) return true;
  return trace.endedAt == null && result.content.length === 0;
}

export const TurnEntryView = memo(TurnEntryViewImpl);
