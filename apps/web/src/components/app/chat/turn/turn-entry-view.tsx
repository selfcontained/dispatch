import { memo, useMemo } from "react";
import type {
  ChatMessage,
  ChatTurnEntry,
  ChatTurnStep,
} from "@dispatch/shared";

import {
  agentAuthor,
  ChatMessageView,
  type FeedContext,
  MessageCopyButton,
  Post,
  POST_BODY_MEASURE,
  SIDE_POST_INDENT,
} from "@/components/app/chat/chat-entries";
import { cn } from "@/lib/utils";

import { ActivityBlock, showsActivity } from "./activity-block";
import { AutoHeight } from "./auto-height";
import type { Step, Trace, Turn } from "./contracts";
import { parseDispatchNotice, PromptLine } from "./prompt-line";
import { turnLabelFromSteps } from "./registry";
import { ResultTurn } from "./result-turn";
import { useTurnContext } from "./turn-context";
import { TurnShortcuts } from "./turn-shortcuts";

/** A turn prompt is never a question, so its post never offers an answer. */
const NO_ANSWER = (): void => undefined;

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
export function promptChatMessage(entry: ChatTurnEntry): ChatMessage {
  return {
    id: entry.prompt.chatMessageId ?? `${entry.id}:prompt`,
    agentId: entry.agentId,
    authorKind: "user",
    kind: "reply",
    text: entry.prompt.text,
    replyTo: null,
    question: null,
    answer: null,
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
};

/**
 * One harness turn as a feed entry: the prompt that opened it, the activity
 * rail, and the answer it ended with. The rail sits inside the agent post so
 * the work and the answer read under one header. No scroll follow of its
 * own: the feed owns that, keyed on `entryGrowthKey`.
 */
function TurnEntryViewImpl({
  entry,
  rule = false,
  ctx,
}: TurnEntryViewProps): JSX.Element {
  const { agent } = useTurnContext();
  const trace = useMemo(() => turnTrace(entry), [entry]);
  const result = useMemo(() => resultTurnModel(entry, trace), [entry, trace]);
  // The folded rail reads "<verb>, 12 steps, 1m 4s", and the verb is the
  // agent's own last dispatch_event message when it sent one. An agent that
  // sent none would fold to a bare "done", so the steps supply the verb
  // instead: "edited turns.ts", "ran pnpm test", "read 3 files".
  const foldLabel = useMemo(
    () => entry.label ?? turnLabelFromSteps(trace.steps),
    [entry.label, trace.steps]
  );
  const notice = useMemo(
    () => parseDispatchNotice(entry.prompt.text, entry.prompt.source),
    [entry.prompt.source, entry.prompt.text]
  );
  /**
   * A message from another agent is already a feed row of its own, written
   * when it was sent rather than when its turn ran, and that row carries the
   * sender's relation badge and id. Rendering it here too showed the same
   * words twice, in two cards that did not even match, and minutes apart
   * whenever the prompt had queued.
   */
  const showsPrompt = entry.prompt.source !== "agent";
  const promptTurn = useMemo(() => promptTurnModel(entry), [entry]);
  const promptMessage = useMemo(() => promptChatMessage(entry), [entry]);
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
        <ChatMessageView
          message={promptMessage}
          held={false}
          grouped={false}
          rule={rule}
          ctx={ctx}
          answering={false}
          answersDisabled
          answeredOptionLabel={null}
          onAnswer={NO_ANSWER}
        />
      ) : null}
      <div className="mt-3">
        <Post
          author={agentAuthor(ctx, "Agent")}
          at={entry.updatedAt}
          grouped={true}
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
              {showsActivity(trace) ? (
                <div className="mb-2">
                  <ActivityBlock trace={trace} label={foldLabel} />
                </div>
              ) : null}
              <ResultTurn turn={result} />
              <TurnShortcuts
                agent={agent}
                agentId={ctx.agentId}
                steps={trace.steps}
              />
            </AutoHeight>
          </div>
        </Post>
      </div>
    </div>
  );
}

export const TurnEntryView = memo(TurnEntryViewImpl);
