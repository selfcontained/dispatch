import { CornerDownRight } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { TurnGlyph } from "@/components/app/chat/turn/activity-block";
import { useAgentTurnLabel } from "@/hooks/use-agent-turn-label";
import { useJumpToTurn } from "@/hooks/use-block-jump";
import { cn } from "@/lib/utils";

/** The step reported as running in the agent's current ACP turn. */
export function AgentActivityLabel({
  agent,
  className,
  linkToTurn = false,
  onNavigate,
}: {
  agent: Agent;
  className?: string;
  linkToTurn?: boolean;
  /** Called as the link navigates (a mobile sidebar closes itself). */
  onNavigate?: () => void;
}): JSX.Element | null {
  const turn = agent.currentTurn ?? null;
  const step = useAgentTurnLabel(agent.id, turn?.blockId ?? null);
  const jumpToTurn = useJumpToTurn();
  if (!turn || !step) return null;

  const content = (
    <>
      <span
        className="flex w-3 shrink-0 items-center justify-center leading-none"
        aria-hidden="true"
      >
        <TurnGlyph
          summary={{ done: false, failed: false, interrupted: false }}
        />
      </span>
      <span className="min-w-0 truncate font-medium text-status-working">
        {step}
      </span>
    </>
  );

  if (!linkToTurn) {
    return (
      <div
        className={cn("flex min-w-0 items-center gap-1.5", className)}
        data-testid={`agent-activity-${agent.id}`}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "group/turn flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-left",
        "hover:underline decoration-muted-foreground/50 underline-offset-2",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className
      )}
      data-testid={`agent-activity-${agent.id}`}
      data-agent-control="true"
      data-turn-link={turn.blockId}
      aria-label={`Go to ${agent.persona ?? agent.name}'s current turn`}
      title="Go to the current turn"
      onClick={(event) => {
        event.stopPropagation();
        onNavigate?.();
        jumpToTurn(agent.id, turn);
      }}
    >
      {content}
      <CornerDownRight
        aria-hidden="true"
        className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/turn:opacity-100 group-focus-visible/turn:opacity-100"
      />
    </button>
  );
}
