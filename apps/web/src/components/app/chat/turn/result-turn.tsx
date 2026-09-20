// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo } from "react";

import { Markdown } from "@/components/ui/markdown";

import type { Turn } from "./contracts";

function ResultTurnImpl({ turn }: { turn: Turn }): JSX.Element {
  const error = turn.error;
  const interrupted = turn.trace?.finalResult === "interrupted";
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
      {showContent ? <ResultText content={turn.content} /> : null}
      {error && turn.content !== error.message ? (
        <ResultText content={error.message} error />
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

function ResultText({
  content,
  error,
}: {
  content: string;
  error?: boolean;
}): JSX.Element {
  return error ? (
    <p className="min-w-0 whitespace-pre-wrap text-[12.5px] leading-[1.6] text-status-blocked">
      {content}
    </p>
  ) : (
    <div className="min-w-0 text-[12.5px] leading-[1.6]">
      <Markdown>{content}</Markdown>
    </div>
  );
}
