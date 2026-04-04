import React from "react";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  Loader2,
  Play,
  Pause,
} from "lucide-react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { latestEventLabel, latestEventColor, formatRelativeTime } from "@/components/app/agent-event-utils";
import { type FeedbackDetailState, ParentFeedbackPanel } from "@/components/app/feedback-panel";
import { PersonaLauncher } from "@/components/app/persona-launcher";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatePresence, motion } from "framer-motion";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

export type AgentCardProps = {
  agent: Agent;
  agents: Agent[];
  childAgents: Agent[];
  selectedAgentId: string | null;
  expandedAgentId: string | null;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (agent: Pick<Agent, "agentArgs" | "fullAccess">) => boolean;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  sendTerminalInput?: (data: string) => void;
  connectedAgentId?: string | null;
  onOpenFeedbackDetail?: (state: FeedbackDetailState) => void;
  feedbackDetailState?: FeedbackDetailState;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
};

export function AgentCard({
  agent,
  agents,
  childAgents,
  selectedAgentId,
  expandedAgentId,
  agentVisualState: getVisualState,
  borderForAgentState,
  toggleAgentDetails,
  isFullAccessEnabled,
  detachTerminal,
  attachToAgent,
  startAgent,
  setDeleteTarget,
  setDeleteConfirmOpen,
  setStopTarget,
  setStopConfirmOpen,
  sendTerminalInput,
  connectedAgentId,
  onOpenFeedbackDetail,
  feedbackDetailState,
  onRequestClose,
  closeOnSessionAction = false,
}: AgentCardProps): JSX.Element {
  const state = getVisualState(agent);
  const isSelected = selectedAgentId === agent.id;
  const isStopped = state === "stopped";
  const isExpanded = expandedAgentId === agent.id;
  const fullAccessEnabled = isFullAccessEnabled(agent);
  const needsAttention = agent.status === "error";

  return (
    <React.Fragment>
      <div
        data-testid={`agent-card-${agent.id}`}
        className={cn(
          "border-b border-r-4 border-border px-2 py-2 transition-colors duration-300",
          borderForAgentState(state),
          isSelected && "bg-muted/60",
          isStopped && "opacity-60"
        )}
      >
        <div
          className={cn("flex items-center gap-1.5", !isStopped && "cursor-pointer")}
          data-testid={`agent-row-${agent.id}`}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("[data-agent-control='true']")) return;
            if (isStopped) return;
            if (connectedAgentId === agent.id) { detachTerminal(); if (isExpanded) toggleAgentDetails(agent.id); return; }
            if (closeOnSessionAction) onRequestClose?.();
            void attachToAgent(agent);
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="min-w-0 flex flex-1 items-center gap-2 text-left text-sm font-semibold">
                <AgentTypeIcon type={agent.type} eventType={agent.status === "running" ? agent.latestEvent?.type : null} />
                <span className="truncate">{agent.name}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{agent.cwd}</TooltipContent>
          </Tooltip>

          {needsAttention ? (
            <Badge
              className="border-status-blocked/45 bg-status-blocked/15 text-status-blocked"
              title={agent.lastError ?? "Agent entered an error state and may need attention."}
            >
              Attention
            </Badge>
          ) : null}

          {isStopped && agent.status !== "archiving" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost-primary"
                  data-agent-control="true"
                  onClick={() => {
                    if (closeOnSessionAction) onRequestClose?.();
                    void startAgent(agent);
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Resume<br /><span className="text-muted-foreground">Resume agent session</span></TooltipContent>
            </Tooltip>
          ) : agent.status === "archiving" ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost-warning"
                  data-agent-control="true"
                  onClick={() => {
                    setStopTarget(agent);
                    setStopConfirmOpen(true);
                  }}
                >
                  <Pause className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pause<br /><span className="text-muted-foreground">Pause agent session</span></TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost-destructive"
                data-agent-control="true"
                data-testid={`agent-archive-${agent.id}`}
                className="ml-auto"
                disabled={agent.status === "archiving" || agent.status === "creating"}
                onClick={() => {
                  setDeleteTarget(agent);
                  setDeleteConfirmOpen(true);
                }}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive<br /><span className="text-muted-foreground">Remove agent</span></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                data-agent-control="true"
                data-testid={`agent-expand-toggle-${agent.id}`}
                onClick={() => {
                  // If collapsing while a child persona is connected, detach it
                  if (isExpanded && connectedAgentId && childAgents.some((c) => c.id === connectedAgentId)) {
                    detachTerminal();
                  }
                  toggleAgentDetails(agent.id);
                }}
              >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", isExpanded && "rotate-180")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isExpanded ? "Hide details" : "Show details"}</TooltipContent>
          </Tooltip>
        </div>

        {agent.status === "creating" && agent.setupPhase ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-status-working">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="truncate font-medium">
              {agent.setupPhase === "worktree" ? "Creating worktree…" :
               agent.setupPhase === "env" ? "Copying environment…" :
               agent.setupPhase === "deps" ? "Installing dependencies…" :
               agent.setupPhase === "session" ? "Starting session…" : "Setting up…"}
            </span>
          </div>
        ) : null}

        {agent.status === "archiving" ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-orange-400">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="truncate font-medium">
              {agent.archivePhase === "stopping" ? "Stopping agent…" :
               agent.archivePhase === "worktree-check" ? "Checking worktree…" :
               agent.archivePhase === "worktree-cleanup" ? "Removing worktree…" :
               agent.archivePhase === "finalizing" ? "Finalizing…" : "Archiving…"}
            </span>
          </div>
        ) : null}

        {agent.latestEvent ? (
          isExpanded ? (
            <div className="mt-1 text-xs text-muted-foreground">
              <div className="flex items-baseline">
                <span className={cn("shrink-0 font-medium", latestEventColor(agent.latestEvent.type))}>{latestEventLabel(agent.latestEvent.type)}</span>
                <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
                <span className="shrink-0">{formatRelativeTime(agent.latestEvent.updatedAt)}</span>
              </div>
              <div className="mt-0.5 leading-relaxed text-muted-foreground">{agent.latestEvent.message}</div>
            </div>
          ) : (
            <div className="mt-1 flex min-w-0 items-baseline text-xs text-muted-foreground">
              <span className={cn("shrink-0 font-medium", latestEventColor(agent.latestEvent.type))}>{latestEventLabel(agent.latestEvent.type)}</span>
              <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
              <span className="shrink-0">{formatRelativeTime(agent.latestEvent.updatedAt)}</span>
              <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
              <span className="min-w-0 truncate">{agent.latestEvent.message}</span>
            </div>
          )
        ) : null}

        <AnimatePresence initial={false}>
          {isExpanded ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mt-2 overflow-hidden"
            >
              <div className="px-3 pb-2 pt-1">
                <div className="grid gap-2 text-xs text-muted-foreground">
                  {agent.gitContext?.isWorktree ? (
                    <>
                      <AgentMeta label="Repo" value={agent.gitContext.repoRoot.split("/").pop() ?? agent.gitContext.repoRoot} />
                      <AgentMeta label="Branch" value={agent.gitContext.branch} mono truncateStart />
                      <AgentMeta label="Worktree" value={agent.cwd} mono truncateStart />
                    </>
                  ) : (
                    <>
                      <AgentMeta label="Working dir" value={agent.cwd} mono truncateStart />
                      {agent.gitContext ? (
                        <AgentMeta label="Branch" value={agent.gitContext.branch} mono truncateStart />
                      ) : (
                        <div className="grid gap-1">
                          <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">Git</div>
                          <div className="text-foreground text-xs">Not a git repository</div>
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="text-foreground">{AGENT_TYPE_LABELS[agent.type as AgentType] ?? agent.type ?? "Codex"}</div>
                    <div
                      className={cn(
                        "inline-flex items-center gap-1 px-1.5 py-0.5 text-foreground text-[11px]",
                        fullAccessEnabled &&
                          "border border-status-waiting/45 bg-status-waiting/15 text-status-waiting"
                      )}
                    >
                      {fullAccessEnabled ? <AlertTriangle className="h-3 w-3" /> : null}
                      <span>{fullAccessEnabled ? "Full access" : "Sandboxed"}</span>
                    </div>
                  </div>
                  {agent.lastError ? <AgentMeta label="Last error" value={agent.lastError} /> : null}
                  {agent.persona ? (
                    <div className="flex items-center gap-1.5">
                      <span className="uppercase tracking-wide text-[10px] text-muted-foreground/80">Persona</span>
                      <Badge variant="running">{agent.persona}</Badge>
                      {agent.parentAgentId ? (
                        <span className="text-[10px] text-muted-foreground">
                          from {agents.find((a) => a.id === agent.parentAgentId)?.name ?? agent.parentAgentId.slice(-6)}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {!isStopped && !agent.persona ? (
                    <PersonaLauncher
                      agent={agent}
                      sendTerminalInput={sendTerminalInput}
                      disabled={connectedAgentId !== agent.id}
                    />
                  ) : null}
                </div>
              </div>
              {!agent.persona ? (
                <div className="px-3 pb-2">
                  <ParentFeedbackPanel
                    parentAgentId={agent.id}
                    sendTerminalInput={sendTerminalInput}
                    isConnected={connectedAgentId === agent.id}
                    onRequestClose={onRequestClose}
                    closeOnSessionAction={closeOnSessionAction}
                    onOpenDetail={onOpenFeedbackDetail}
                    activeDetailItemId={feedbackDetailState?.parentAgentId === agent.id ? feedbackDetailState.itemId : null}
                    childAgents={childAgents}
                    selectedAgentId={selectedAgentId}
                    agentVisualState={getVisualState}
                    detachTerminal={detachTerminal}
                    attachToAgent={attachToAgent}
                    setDeleteTarget={setDeleteTarget}
                    setDeleteConfirmOpen={setDeleteConfirmOpen}
                  />
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </React.Fragment>
  );
}
