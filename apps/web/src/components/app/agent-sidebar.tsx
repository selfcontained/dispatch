import {
  Activity,
  Bot,
  ChevronDown,
  ChevronLeft,
  AlarmClock,
  Settings,
  X
} from "lucide-react";
import { useIconColor } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";

import { AgentCard } from "@/components/app/agent-card";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type FeedbackDetailState } from "@/components/app/feedback-panel";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import React from "react";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

type AgentSidebarSharedProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  expandedAgentId: string | null;
  overflowAgentId: string | null;
  onOpenCreateDialog: (type?: AgentType) => void;
  enabledAgentTypes: AgentType[];
  lastUsedAgentType: AgentType | null;
  onOpenActivity: () => void;
  onOpenJobs: () => void;
  onOpenSettings: () => void;
  setOverflowAgentId: (value: string | null | ((current: string | null) => string | null)) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (agent: Pick<Agent, "agentArgs" | "fullAccess">) => boolean;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
  sendTerminalInput?: (data: string) => void;
  connectedAgentId?: string | null;
  onOpenFeedbackDetail?: (state: FeedbackDetailState) => void;
  feedbackDetailState?: FeedbackDetailState;
};

type AgentSidebarProps = AgentSidebarSharedProps & {
  leftOpen: boolean;
  setLeftOpen: (open: boolean) => void;
};

type AgentSidebarContentProps = AgentSidebarSharedProps & {
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
  closeButtonIcon?: "chevron" | "x";
  className?: string;
};

export function AgentSidebarContent({
  agents,
  selectedAgentId,
  expandedAgentId,
  overflowAgentId: _overflowAgentId,
  onOpenCreateDialog,
  enabledAgentTypes,
  lastUsedAgentType,
  onOpenActivity,
  onOpenJobs,
  onOpenSettings,
  setOverflowAgentId: _setOverflowAgentId,
  setDeleteTarget,
  setDeleteConfirmOpen,
  setStopTarget,
  setStopConfirmOpen,
  agentVisualState,
  borderForAgentState,
  toggleAgentDetails,
  isFullAccessEnabled,
  detachTerminal,
  attachToAgent,
  startAgent,
  sendTerminalInput,
  connectedAgentId,
  onOpenFeedbackDetail,
  feedbackDetailState,
  onRequestClose,
  closeOnSessionAction = false,
  closeButtonIcon = "x",
  className
}: AgentSidebarContentProps): JSX.Element {
  const { iconColor } = useIconColor();
  const { instanceName } = useInstanceName();

  const defaultCreateType: AgentType = lastUsedAgentType && enabledAgentTypes.includes(lastUsedAgentType)
    ? lastUsedAgentType
    : enabledAgentTypes[0] ?? "codex";

  return (
    <aside data-testid="agent-sidebar" className={cn("flex h-full min-h-0 w-full flex-col border-r-2 border-border bg-card text-foreground", className)}>
      <div className="flex min-h-14 items-center px-3 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2.5">
          <img src={`/icons/${iconColor}/brand-icon.svg`} alt="" className="h-7 w-7 shrink-0 object-contain" />
          <div className="flex min-w-0 flex-col justify-center">
            <div className="text-sm font-bold uppercase tracking-widest text-foreground">Dispatch</div>
            {instanceName ? (
              <div title={instanceName} className="truncate text-[11px] leading-tight text-muted-foreground">{instanceName}</div>
            ) : null}
          </div>
        </div>
        {onRequestClose ? (
          <div className="ml-auto">
            <Button size="icon" variant="ghost" onClick={onRequestClose} title="Close sidebar">
              {closeButtonIcon === "chevron" ? <ChevronLeft className="h-4 w-4" /> : <X className="h-4 w-4" />}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Agents</div>
        <div className="ml-auto flex items-center">
            <Button
              size="sm"
              variant="default"
              className="rounded-r-none border-r-0 bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
              onClick={() => onOpenCreateDialog(defaultCreateType)}
              data-testid="create-agent-button"
            >
              <AgentTypeIcon type={defaultCreateType} className="mr-1 h-4 w-4 border-none bg-transparent p-0 text-foreground/80" />
              Create
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="default"
                  className="rounded-l-none border-l border-border/80 bg-muted/35 px-1 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
                  data-testid="create-agent-type-dropdown"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {enabledAgentTypes.map((agentType) => (
                  <DropdownMenuItem
                    key={agentType}
                    className="text-foreground"
                    onClick={() => onOpenCreateDialog(agentType)}
                    data-testid={`create-agent-type-${agentType}`}
                  >
                    <AgentTypeIcon type={agentType} className="mr-2 h-4 w-4" />
                    {AGENT_TYPE_LABELS[agentType]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TooltipProvider delayDuration={120}>
          {agents.length === 0 ? (
            <div data-testid="no-agents-message" className="p-4 text-sm text-muted-foreground">No agents yet.</div>
          ) : (
            <React.Fragment>
            {agents.filter((a) => !a.parentAgentId).map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                agents={agents}
                childAgents={agents.filter((a) => a.parentAgentId === agent.id)}
                selectedAgentId={selectedAgentId}
                expandedAgentId={expandedAgentId}
                agentVisualState={agentVisualState}
                borderForAgentState={borderForAgentState}
                toggleAgentDetails={toggleAgentDetails}
                isFullAccessEnabled={isFullAccessEnabled}
                detachTerminal={detachTerminal}
                attachToAgent={attachToAgent}
                startAgent={startAgent}
                setDeleteTarget={setDeleteTarget}
                setDeleteConfirmOpen={setDeleteConfirmOpen}
                setStopTarget={setStopTarget}
                setStopConfirmOpen={setStopConfirmOpen}
                sendTerminalInput={sendTerminalInput}
                connectedAgentId={connectedAgentId}
                onOpenFeedbackDetail={onOpenFeedbackDetail}
                feedbackDetailState={feedbackDetailState}
                onRequestClose={onRequestClose}
                closeOnSessionAction={closeOnSessionAction}
              />
            ))}
            </React.Fragment>
          )}
        </TooltipProvider>
      </div>
      <TooltipProvider delayDuration={120}>
        <div className="flex items-center justify-around border-t border-border py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => undefined}
                aria-label="Agents"
                data-testid="agents-button"
                className="rounded-md p-2 text-primary transition-colors hover:text-primary/80"
              >
                <Bot className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Agents</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenJobs}
                aria-label="Jobs"
                data-testid="jobs-button"
                className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <AlarmClock className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Jobs</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenActivity}
                data-testid="activity-button"
                className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <Activity className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Activity</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                data-testid="settings-button"
                className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <Settings className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </aside>
  );
}

export function AgentSidebar({ leftOpen, setLeftOpen, ...props }: AgentSidebarProps): JSX.Element {
  return (
    <div
      className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: leftOpen ? 320 : 0 }}
    >
      <AgentSidebarContent
        {...props}
        onRequestClose={() => setLeftOpen(false)}
        closeOnSessionAction={false}
        closeButtonIcon="chevron"
        className="w-[320px]"
      />
    </div>
  );
}
