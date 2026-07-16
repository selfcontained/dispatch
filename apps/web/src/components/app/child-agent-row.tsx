import { Play, Terminal, X } from "lucide-react";

import {
  formatRelativeTime,
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ChildAgentRowProps = {
  agent: Agent;
  state: AgentVisualState;
  isInitialReviewActive: boolean;
  isConnected: boolean;
  attachToAgent: (agent: Agent) => Promise<void>;
  detachTerminal: () => void;
  startAgent: (agent: Agent) => Promise<void>;
  openSubmittedReview: (agent: Agent) => void;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
};

export function ChildAgentRow({
  agent,
  state,
  isInitialReviewActive,
  isConnected,
  attachToAgent,
  detachTerminal,
  startAgent,
  openSubmittedReview,
  onRequestClose,
  closeOnSessionAction = false,
}: ChildAgentRowProps): JSX.Element {
  const isStopped = state === "stopped";
  const isReviewAgent = agent.role === "review";
  const canOpenSubmittedReview =
    isReviewAgent && agent.submittedReviewId != null;
  const showReviewActivity =
    isReviewAgent && agent.status === "running" && isInitialReviewActive;
  const displayName = agent.persona ?? agent.name;
  const statusLabel = isStopped
    ? "Stopped"
    : agent.status === "error"
      ? "Error"
      : agent.latestEvent
        ? latestEventLabel(agent.latestEvent.type)
        : "Running";
  const statusColor =
    agent.status === "error"
      ? "text-status-blocked"
      : agent.latestEvent && !isStopped
        ? latestEventColor(agent.latestEvent.type)
        : "text-muted-foreground";

  return (
    <div
      data-testid={`child-agent-row-${agent.id}`}
      data-agent-role={agent.role ?? "standard"}
      data-review-active={showReviewActivity ? "true" : "false"}
      className={cn(
        "group relative flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/30 px-2 py-1 sm:py-1.5",
        "transition-colors hover:bg-muted/35",
        canOpenSubmittedReview && "cursor-pointer",
        isConnected && "border-primary/35 bg-muted/40",
        isStopped && "opacity-65",
        showReviewActivity && "child-agent-review-active-row"
      )}
    >
      {canOpenSubmittedReview ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={`child-agent-open-review-${agent.id}`}
              aria-label={`Open submitted review from ${displayName}`}
              className="absolute inset-0 z-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                openSubmittedReview(agent);
              }}
            />
          </TooltipTrigger>
          <TooltipContent>Open submitted review</TooltipContent>
        </Tooltip>
      ) : null}
      <AgentTypeIcon
        type={agent.type}
        eventType={
          agent.status === "running" ? agent.latestEvent?.type : undefined
        }
        className="pointer-events-none relative z-10 h-4.5 w-4.5"
      />
      <div className="pointer-events-none relative z-10 min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 truncate text-[11px] font-medium"
            title={agent.name}
          >
            {displayName}
          </span>
          {isReviewAgent ? (
            <Badge className="ml-auto h-4 shrink-0 border-primary bg-background px-1 text-[8px] font-semibold uppercase tracking-wide text-foreground">
              Review
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center text-[10px]">
          <span className={cn("font-medium", statusColor)}>{statusLabel}</span>
          {agent.latestEvent?.updatedAt ? (
            <>
              <span className="mx-1 text-muted-foreground/50">•</span>
              <span className="truncate text-muted-foreground/70">
                {formatRelativeTime(agent.latestEvent.updatedAt)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {isStopped ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost-primary"
              data-agent-control="true"
              data-testid={`child-agent-resume-${agent.id}`}
              aria-label={`Resume ${displayName}`}
              className="relative z-20 h-11 w-11 shrink-0 sm:h-7 sm:w-7"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                void startAgent(agent);
              }}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Resume child agent</TooltipContent>
        </Tooltip>
      ) : isConnected ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              data-agent-control="true"
              data-testid={`child-agent-detach-${agent.id}`}
              aria-label={`Detach from ${displayName}`}
              className="relative z-20 h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
              onClick={detachTerminal}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Detach</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              data-agent-control="true"
              data-testid={`child-agent-attach-${agent.id}`}
              aria-label={`Attach to ${displayName}`}
              className="relative z-20 h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                void attachToAgent(agent);
              }}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>View terminal</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
