import { Archive, ChevronRight, ListChecks, Terminal, X } from "lucide-react";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { latestEventLabel, latestEventColor } from "@/components/app/agent-event-utils";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type PersonaAgentRowProps = {
  child: Agent;
  childIndex: number;
  childState: AgentVisualState;
  isSelected: boolean;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
  feedbackCount?: number;
  isCollapsed?: boolean;
  hasFeedback?: boolean;
  onTriage?: () => void;
  triageDisabled?: boolean;
};

export function PersonaAgentRow({
  child,
  childIndex,
  childState,
  isSelected,
  detachTerminal,
  attachToAgent,
  setDeleteTarget,
  setDeleteConfirmOpen,
  onRequestClose,
  closeOnSessionAction,
  feedbackCount,
  isCollapsed,
  hasFeedback,
  onTriage,
  triageDisabled,
}: PersonaAgentRowProps): JSX.Element {
  const childIsStopped = childState === "stopped";
  const childIsActive = childState === "active";
  const colorVar = `var(--chart-${(childIndex % 4) + 1})`;

  return (
    <div
      data-testid={`agent-card-${child.id}`}
      className={cn(
        "flex items-center gap-2 border-r-2 px-2 py-1.5 transition-colors duration-200",
        hasFeedback && "cursor-pointer hover:bg-muted/50",
        childIsStopped && "opacity-50",
        isSelected ? "border-r-status-done" : "border-r-transparent"
      )}
    >
      {hasFeedback ? (
        <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform", !isCollapsed && "rotate-90")} />
      ) : null}
      <AgentTypeIcon type={child.type} eventType={child.status === "running" ? child.latestEvent?.type : null} className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium" style={{ color: `hsl(${colorVar})` }}>
            {child.persona ?? child.name}
          </span>
          {feedbackCount != null && feedbackCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/20 px-1 text-[10px] font-semibold text-primary">{feedbackCount}</span>
          ) : null}
        </div>
        {child.latestEvent ? (
          <div className="mt-0.5 text-[10px]">
            <span className={cn("font-medium", latestEventColor(child.latestEvent.type))}>{latestEventLabel(child.latestEvent.type)}</span>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {onTriage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span data-agent-control="true" className={cn(triageDisabled && "cursor-not-allowed")}>
                <button
                  aria-label="Auto-triage feedback"
                  className={cn("rounded p-0.5 transition-colors", triageDisabled ? "text-muted-foreground/25 pointer-events-none" : "text-muted-foreground/50 hover:text-foreground")}
                  onClick={onTriage}
                >
                  <ListChecks className="h-3.5 w-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{triageDisabled ? "Connect to parent agent to auto-triage" : "Auto-triage feedback"}</TooltipContent>
          </Tooltip>
        ) : null}
        {!childIsStopped ? (
          childIsActive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-agent-control="true"
                  aria-label="Disconnect from agent"
                  className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
                  onClick={() => detachTerminal()}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Disconnect</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-agent-control="true"
                  aria-label="Connect to agent terminal"
                  className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
                  onClick={() => {
                    if (closeOnSessionAction) onRequestClose?.();
                    void attachToAgent(child);
                  }}
                >
                  <Terminal className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>View terminal</TooltipContent>
            </Tooltip>
          )
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button data-agent-control="true" aria-label="Archive agent" data-testid={`agent-archive-${child.id}`} className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors disabled:opacity-30" disabled={child.status === "archiving"} onClick={() => { setDeleteTarget(child); setDeleteConfirmOpen(true); }}><Archive className="h-3.5 w-3.5" /></button>
          </TooltipTrigger>
          <TooltipContent>Archive</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
