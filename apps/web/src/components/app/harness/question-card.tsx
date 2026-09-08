import { Check } from "lucide-react";
import type { ChatQuestionOption, HarnessQuestion } from "@dispatch/shared";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

/**
 * A question the agent posted through dispatch_chat_post, with its option
 * buttons. Mirrors the Chat feed's question card: the Harness view is the
 * only surface a harness agent's pane shows, so the buttons live here too.
 */
export function QuestionCard({
  question,
  answering,
  disabled,
  onAnswer,
}: {
  question: HarnessQuestion;
  /** This question's answer is in flight. */
  answering: boolean;
  /** Nothing can be sent right now. */
  disabled: boolean;
  onAnswer: (option: ChatQuestionOption) => void;
}): JSX.Element {
  const open = question.answer === null;
  const optionsDisabled = !open || answering || disabled;
  return (
    <div
      className={cn(
        "ml-[21px] mb-3.5 rounded-md border p-3",
        open
          ? "border-status-waiting/50 bg-status-waiting/[0.07]"
          : "border-border bg-muted/30"
      )}
      data-testid="harness-question"
      data-open={open ? "true" : "false"}
    >
      {open ? (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-status-waiting">
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Needs your reply
        </div>
      ) : (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Check className="h-3 w-3" />
          Answered
          <span className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true">·</span>
            <Markdown variant="inline" className="truncate">
              {question.answer?.label ?? question.answer?.value ?? ""}
            </Markdown>
          </span>
        </div>
      )}
      <p className="mb-2 whitespace-pre-wrap text-[12px] leading-[1.55] text-foreground">
        {question.text}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option, index) => {
          const value = option.value ?? option.label;
          const chosen =
            question.answer !== null && question.answer.value === value;
          return (
            <Button
              key={`${index}-${value}`}
              type="button"
              size="sm"
              variant={chosen ? "primary" : "default"}
              className={cn(
                "h-7 gap-1 text-xs",
                // The Chat feed's card does this: on a phone or any touch
                // screen the option is a real tap target and its label wraps
                // rather than being clipped.
                "max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal max-sm:py-2 max-sm:text-left",
                "[@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:whitespace-normal [@media(pointer:coarse)]:py-2 [@media(pointer:coarse)]:text-left",
                chosen && "cursor-default"
              )}
              // Every option, the chosen one included: left enabled it stayed
              // in the tab order and Enter re-answered a settled question.
              disabled={optionsDisabled}
              aria-pressed={chosen}
              onClick={() => onAnswer(option)}
              data-testid="harness-question-option"
            >
              {chosen ? <Check className="h-3 w-3" /> : null}
              <Markdown variant="inline">{option.label}</Markdown>
            </Button>
          );
        })}
      </div>
      {open && question.allowFreeform && !disabled ? (
        <p className="mt-2 text-[10.5px] text-muted-foreground">
          Or type a reply below.
        </p>
      ) : null}
    </div>
  );
}
