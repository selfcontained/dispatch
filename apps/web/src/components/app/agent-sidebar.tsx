import { ChevronDown } from "lucide-react";

import { AgentCard } from "@/components/app/agent-card";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type FeedbackDetailState } from "@/components/app/feedback-panel";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import React from "react";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";

export type AgentListContentProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  expandedAgentId: string | null;
  overflowAgentId: string | null;
  onOpenCreateDialog: (type?: AgentType) => void;
  enabledAgentTypes: AgentType[];
  lastUsedAgentType: AgentType | null;
  setOverflowAgentId: (
    value: string | null | ((current: string | null) => string | null)
  ) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (
    agent: Pick<Agent, "agentArgs" | "fullAccess">
  ) => boolean;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
  sendTerminalInput?: (data: string) => void;
  connectedAgentId?: string | null;
  onOpenFeedbackDetail?: (state: FeedbackDetailState) => void;
  feedbackDetailState?: FeedbackDetailState;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
};

export function AgentListContent({
  agents,
  selectedAgentId,
  expandedAgentId,
  overflowAgentId: _overflowAgentId,
  onOpenCreateDialog,
  enabledAgentTypes,
  lastUsedAgentType,
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
}: AgentListContentProps): JSX.Element {
  const defaultCreateType: AgentType =
    lastUsedAgentType && enabledAgentTypes.includes(lastUsedAgentType)
      ? lastUsedAgentType
      : (enabledAgentTypes[0] ?? "codex");

  return (
    <div data-testid="agent-sidebar" className="flex h-full min-h-0 flex-col">
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Agents
        </div>
        <div className="ml-auto flex items-center">
          <Button
            size="sm"
            variant="default"
            className="rounded-r-none border-r-0 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenCreateDialog(defaultCreateType)}
            data-testid="create-agent-button"
          >
            <AgentTypeIcon
              type={defaultCreateType}
              className="mr-1 h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
            />
            Create
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="default"
                className="rounded-l-none border-l border-white/[0.12] px-1 text-muted-foreground hover:text-foreground"
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

      <div
        data-testid="agent-sidebar-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <TooltipProvider delayDuration={120}>
          {agents.length === 0 ? (
            <div
              data-testid="no-agents-message"
              className="p-4 text-sm text-muted-foreground"
            >
              No agents yet.
            </div>
          ) : (
            <React.Fragment>
              {agents
                .filter((a) => !a.parentAgentId)
                .map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    agents={agents}
                    childAgents={agents.filter(
                      (a) => a.parentAgentId === agent.id
                    )}
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
                    enabledAgentTypes={enabledAgentTypes}
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
    </div>
  );
}
