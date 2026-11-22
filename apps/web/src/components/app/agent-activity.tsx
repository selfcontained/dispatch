import { useEffect, useState } from "react";
import { Clock, Clock3, CornerDownRight } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { TurnGlyph } from "@/components/app/chat/turn/activity-block";
import { ActivityBars } from "@/components/ui/activity-bars";
import { useAgentTurnLabel } from "@/hooks/use-agent-turn-label";
import { useLocalDay } from "@/hooks/use-local-day";
import { useJumpToTurn } from "@/hooks/use-block-jump";
import { cn } from "@/lib/utils";

import {
  scheduleTime,
  sidebarScheduleTime,
  scheduleTimezone,
  useUpcomingSchedule,
} from "./scheduled-messages";
import { RowButton } from "@/components/ui/row-button";
import { Hint } from "@/components/ui/tooltip";

function ScheduledActivity({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  const schedule = useUpcomingSchedule(agentId);
  const today = useLocalDay();
  if (!schedule) return null;
  return (
    <Hint
      label={`Next scheduled message: ${scheduleTime(schedule.nextDueAt)} (${scheduleTimezone()})`}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-heading-accent-1",
          className
        )}
        data-testid={`agent-scheduled-activity-${agentId}`}
      >
        <Clock aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-medium">
          Next{" "}
          <time dateTime={schedule.nextDueAt}>
            {sidebarScheduleTime(schedule.nextDueAt, today)}
          </time>
        </span>
      </div>
    </Hint>
  );
}

/** Reconnection uses the normal activity slot rather than an error paragraph. */
function ReconnectActivity({
  agent,
  className,
}: {
  agent: Agent;
  className?: string;
}): JSX.Element {
  const reconnect = agent.reconnect!;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (reconnect.phase !== "waiting") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [reconnect.phase]);
  const seconds = reconnect.nextRetryAt
    ? Math.max(0, Math.ceil((Date.parse(reconnect.nextRetryAt) - now) / 1_000))
    : null;
  const detail =
    reconnect.phase === "trying"
      ? "Trying now"
      : seconds === null
        ? "Checking soon"
        : seconds > 0
          ? `Next try in ${seconds}s`
          : "Checking soon";
  return (
    <Hint label="The agent host is running; Dispatch is retrying its connection.">
      <div
        className={cn("flex min-w-0 items-center gap-1.5", className)}
        data-testid={`agent-activity-${agent.id}`}
      >
        {reconnect.phase === "trying" ? (
          <ActivityBars size={12} className="text-status-working" />
        ) : (
          <Clock3
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-status-waiting"
          />
        )}
        <span className="shrink-0 font-medium text-status-waiting">
          Reconnecting
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
      </div>
    </Hint>
  );
}

/** The step reported as running in the agent's current ACP turn. */
export function AgentActivityLabel({
  agent,
  className,
  linkToTurn = false,
  scheduledFallback = false,
  onNavigate,
}: {
  agent: Agent;
  className?: string;
  linkToTurn?: boolean;
  scheduledFallback?: boolean;
  /** Called as the link navigates (a mobile sidebar closes itself). */
  onNavigate?: () => void;
}): JSX.Element | null {
  const turn = agent.currentTurn ?? null;
  const step = useAgentTurnLabel(agent.id, turn?.blockId ?? null);
  const jumpToTurn = useJumpToTurn();
  if (agent.reconnect) {
    return <ReconnectActivity agent={agent} className={className} />;
  }
  if (!turn || !step)
    return scheduledFallback ? (
      <ScheduledActivity agentId={agent.id} className={className} />
    ) : null;

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
    <Hint label="Go to the current turn">
      <RowButton
        className={cn(
          "group/turn w-auto min-w-0 max-w-full gap-1.5 rounded-sm hover:bg-transparent pointer-coarse:min-h-0",
          "hover:underline decoration-muted-foreground/line underline-offset-2",
          className
        )}
        data-testid={`agent-activity-${agent.id}`}
        data-agent-control="true"
        data-turn-link={turn.blockId}
        aria-label={`Go to ${agent.role === "review" ? (agent.persona ?? agent.name) : agent.name}'s current turn`}
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
      </RowButton>
    </Hint>
  );
}
