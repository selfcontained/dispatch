// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo } from "react";

import { Markdown } from "@/components/ui/markdown";

import type { Turn } from "./contracts";

/** Markdown sets foreground on headings, bold, list items and code; mute them all. */
const MUTED_MARKDOWN =
  "text-muted-foreground prose-headings:text-muted-foreground prose-strong:text-muted-foreground prose-li:text-muted-foreground prose-code:text-muted-foreground";

/** Where a failed turn's retry stands; see `ChatTurnEntry.retry`. */
export type ResultRetry = {
  state: "open" | "retried";
  /** Absent, a view that cannot run a retry offers none. */
  onRetry?: () => void;
  pending?: boolean;
};

function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

function ResultTurnImpl({
  turn,
  retry,
}: {
  turn: Turn;
  retry?: ResultRetry;
}): JSX.Element {
  const error = turn.error;
  const interrupted = turn.trace?.finalResult === "interrupted";
  // The engine often reports a failure as the turn's text too; saying it
  // twice, once as the answer and once as the error, is noise.
  const echoesError = !!error && sameText(turn.content, error.message);
  if (error && retry?.state === "retried") {
    // Retried: the failure is history, so it folds to one quiet line and
    // the retry's own turn, below, carries the conversation on.
    return (
      <div className="space-y-2" data-testid="harness-result">
        {turn.content && !echoesError ? <ResultBody turn={turn} /> : null}
        <p
          className="flex min-w-0 items-center gap-[9px] text-[11.5px] text-muted-foreground"
          title={error.message}
          data-testid="harness-retried"
        >
          <span aria-hidden="true" className="select-none font-bold">
            ■
          </span>
          <span className="min-w-0 truncate">
            {error.message.split("\n")[0]}
          </span>
          <span className="shrink-0">· retried</span>
        </p>
      </div>
    );
  }
  const showContent = !!turn.content;
  return (
    <div
      // The message arrives like a new message would: after the activity
      // line has come to rest, sliding up as it fades in. A CSS keyframe,
      // not a framer animation, so it runs on phones too, where the pane
      // keeps framer's layout work off.
      className="space-y-2 animate-message-in motion-reduce:animate-none"
      data-testid="harness-result"
    >
      {showContent ? <ResultBody turn={turn} /> : null}
      {error && !echoesError ? (
        <ResultText content={error.message} error />
      ) : null}
      {error && retry?.state === "open" && retry.onRetry ? (
        // Worded like a post's "Not delivered · Send again": the same
        // failure line. "Turn" is what tells the two apart — this one runs
        // the agent again, where that one re-sends words it never took.
        <p
          className="flex items-center gap-[9px] text-[11.5px] text-status-blocked"
          data-testid="harness-turn-failed"
        >
          <span aria-hidden="true" className="select-none font-bold">
            ■
          </span>
          The turn stopped on an error.
          <button
            type="button"
            className="underline underline-offset-2 hover:no-underline disabled:opacity-60"
            disabled={retry.pending}
            onClick={retry.onRetry}
            data-testid="harness-retry-turn"
          >
            {retry.pending ? "Retrying…" : "Retry turn"}
          </button>
        </p>
      ) : null}
      {interrupted ? (
        <p
          className="flex items-center gap-[9px] text-[11.5px] text-status-waiting"
          data-testid="harness-interrupted"
        >
          <span aria-hidden="true" className="select-none font-bold">
            ■
          </span>
          Interrupted mid-turn: the agent was stopped before it finished.
        </p>
      ) : null}
    </div>
  );
}

export const ResultTurn = memo(ResultTurnImpl);

/**
 * The answer's text. What the agent said while it worked reads muted, so
 * the final reply under it stands out and a reader can skip to it.
 */
function ResultBody({ turn }: { turn: Turn }): JSX.Element {
  const final = turn.lead ? turn.content.slice(turn.lead.length).trim() : "";
  if (!turn.lead || !final) return <ResultText content={turn.content} />;
  return (
    <>
      <ResultText content={turn.lead} muted />
      <ResultText content={final} />
    </>
  );
}

function ResultText({
  content,
  error,
  muted,
}: {
  content: string;
  error?: boolean;
  muted?: boolean;
}): JSX.Element {
  return error ? (
    <p className="min-w-0 whitespace-pre-wrap text-[12.5px] leading-[1.6] text-status-blocked">
      {content}
    </p>
  ) : (
    <div
      className="min-w-0 text-[12.5px] leading-[1.6]"
      data-testid={muted ? "harness-result-lead" : undefined}
    >
      <Markdown className={muted ? MUTED_MARKDOWN : undefined}>
        {content}
      </Markdown>
    </div>
  );
}
