// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo } from "react";
import { motion } from "framer-motion";

import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

import type { Turn } from "./contracts";
import { arrive, fadeVariants } from "./motion";

function ResultTurnImpl({ turn }: { turn: Turn }): JSX.Element {
  const error = turn.error;
  const interrupted = turn.trace?.finalResult === "interrupted";
  const showContent = !!turn.content;
  return (
    <motion.div
      variants={fadeVariants}
      initial="hidden"
      animate="shown"
      transition={arrive()}
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
  return (
    <div className="flex items-start gap-[9px]">
      <span
        aria-hidden="true"
        className={cn(
          "select-none text-[13px] leading-[1.6]",
          error ? "text-status-blocked" : "text-status-working"
        )}
      >
        ▪
      </span>
      {error ? (
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.6] text-status-blocked">
          {content}
        </p>
      ) : (
        <div className="min-w-0 flex-1 text-[12.5px] leading-[1.6]">
          <Markdown>{content}</Markdown>
        </div>
      )}
    </div>
  );
}
