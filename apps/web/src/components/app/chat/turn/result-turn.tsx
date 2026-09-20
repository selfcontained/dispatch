// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo } from "react";
import { motion } from "framer-motion";

import { Markdown } from "@/components/ui/markdown";

import type { Turn } from "./contracts";
import { arrive, DURATION } from "./motion";

function ResultTurnImpl({ turn }: { turn: Turn }): JSX.Element {
  const error = turn.error;
  const interrupted = turn.trace?.finalResult === "interrupted";
  const showContent = !!turn.content;
  return (
    <motion.div
      // The message arrives like a new message would: after the activity
      // line has settled, sliding up as it fades in.
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...arrive(0.45), delay: 0.12 }}
      className="space-y-2"
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
    </motion.div>
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
