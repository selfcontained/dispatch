// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo } from "react";

import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

import type { Turn } from "./contracts";

function ResultTurnImpl({
  turn,
  isStreaming = false,
}: {
  turn: Turn;
  isStreaming?: boolean;
}): JSX.Element | null {
  // While this turn is streaming (the live placeholder), the ActivityBlock
  // above is the sole progress indicator — render nothing here.
  if (isStreaming) return null;
  const error = turn.error;
  const showContent = !!turn.content;
  return (
    <div
      className="animate-harness-msg space-y-2 motion-reduce:animate-none"
      data-testid="harness-result"
    >
      {showContent ? <ResultText content={turn.content} /> : null}
      {error && turn.content !== error.message ? (
        <ResultText content={error.message} error />
      ) : null}
      {error?.hint ? (
        <p className="pl-[21px] text-[11px] text-muted-foreground">
          {error.hint}
        </p>
      ) : null}
      <div className="pl-[21px] text-[10.5px] text-muted-foreground">
        {new Date(turn.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}

export const ResultTurn = memo(ResultTurnImpl);

export function ResultText({
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
