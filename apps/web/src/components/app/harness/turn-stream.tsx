// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { ActivityBlock } from "./activity-block";
import type { Attachment, Trace, Turn } from "./contracts";
import { PromptLine } from "./prompt-line";
import { ResultText, ResultTurn } from "./result-turn";

function showsActivity(trace: Trace | null | undefined): trace is Trace {
  if (!trace) return false;
  return !(trace.endedAt != null && trace.steps.length === 0);
}

/**
 * The fused stream: prompt line, activity block, result, per turn; then
 * the live turn's block and growing text. Follows the bottom while the
 * reader is near it, like the Chat pane.
 */
export function TurnStream({
  turns,
  liveTrace,
  liveText,
  streaming = false,
  emptyState,
  onAttachmentClick,
  ariaLabel = "Harness conversation",
}: {
  turns: Turn[];
  liveTrace?: Trace | null;
  liveText?: string;
  streaming?: boolean;
  emptyState?: ReactNode;
  onAttachmentClick?: (a: Attachment) => void;
  ariaLabel?: string;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the bottom only while the reader is there. A refetch rebuilds
  // the turn array, so identity is no signal; what matters is whether the
  // reader scrolled away, tracked on scroll and consulted on every change.
  const followingRef = useRef(true);
  const lastTurnCountRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      followingRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const lastTurnId = turns.length ? turns[turns.length - 1].id : null;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // First paint with content, or a new turn while following: go to the end.
    const first = lastTurnCountRef.current === 0;
    const grew = turns.length > lastTurnCountRef.current;
    lastTurnCountRef.current = turns.length;
    if (grew && (first || followingRef.current)) {
      el.scrollTop = el.scrollHeight;
      followingRef.current = true;
    }
  }, [lastTurnId, turns.length]);

  const liveStepCount = liveTrace?.steps.length ?? 0;
  const liveEnded = liveTrace?.endedAt ?? null;
  const liveTextLength = liveText?.length ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followingRef.current) el.scrollTop = el.scrollHeight;
  }, [liveStepCount, liveEnded, liveTextLength, streaming]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={ariaLabel}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-4 font-terminal"
      data-testid="harness-stream"
    >
      {turns.length === 0 ? emptyState : null}
      {turns.map((turn) => {
        if (turn.role === "user") {
          return (
            <PromptLine
              key={turn.id}
              turn={turn}
              onAttachmentClick={onAttachmentClick}
            />
          );
        }
        return (
          <div key={turn.id} className="mb-3.5">
            {showsActivity(turn.trace) ? (
              <div className="mb-2">
                <ActivityBlock trace={turn.trace} />
              </div>
            ) : null}
            <ResultTurn turn={turn} />
          </div>
        );
      })}
      {streaming && liveTrace ? (
        <div className="mb-3.5" data-testid="harness-live-activity">
          <ActivityBlock trace={liveTrace} />
        </div>
      ) : null}
      {streaming && liveText ? (
        <div className="mb-3.5" data-testid="harness-live-text">
          <ResultText content={liveText} />
        </div>
      ) : null}
    </div>
  );
}
