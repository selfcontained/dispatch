import React from "react";
import {
  AlarmClock,
  ArrowDownToLine,
  ChevronDown,
  Play,
  Tag,
} from "lucide-react";
import { AgentCardDetails } from "@/components/app/agent-card-details";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import {
  latestEventLabel,
  latestEventColor,
  formatRelativeTime,
} from "@/components/app/agent-event-utils";
import { type FeedbackDetailState } from "@/components/app/feedback-panel";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { type AgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";

function RepoLabel({
  agentId,
  repoIconPath,
  name,
}: {
  agentId: string;
  repoIconPath?: string | null;
  name: string;
}) {
  const [iconError, setIconError] = React.useState(false);
  const showIcon = !!repoIconPath && !iconError;

  return (
    <span className="ml-auto flex min-w-0 items-center gap-1 pl-2">
      {showIcon ? (
        <img
          src={`/api/v1/agents/${agentId}/repo-icon`}
          alt=""
          className="h-3.5 w-3.5 shrink-0 object-contain"
          onError={() => setIconError(true)}
        />
      ) : null}
      <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/60">
        {name}
      </span>
    </span>
  );
}

function hasDefaultSessionName(agent: Agent): boolean {
  if (agent.persona) return false;
  if (agent.type === "terminal") return false;
  if (agent.name.startsWith("job-")) return false;
  return agent.name.trim() === `agent-${agent.id.slice(-6)}`;
}

export type AgentCardProps = {
  agent: Agent;
  agents: Agent[];
  childAgents: Agent[];
  selectedAgentId: string | null;
  expandedAgentId: string | null;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (
    agent: Pick<Agent, "agentArgs" | "fullAccess">
  ) => boolean;
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
  enabledAgentTypes: AgentType[];
  enabledIdes: IdeType[];
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
  enabledAgentTypes,
  enabledIdes,
}: AgentCardProps): JSX.Element {
  const state = getVisualState(agent);
  const hasActiveChild = childAgents.some(
    (child) => child.id === connectedAgentId
  );
  const effectiveState: AgentVisualState = hasActiveChild ? "idle" : state;
  const isSelected = selectedAgentId === agent.id && !hasActiveChild;
  const isStopped = state === "stopped";
  const isExpanded = expandedAgentId === agent.id;
  const [renamePromptPending, setRenamePromptPending] = React.useState(false);
  const needsAttention = agent.status === "error";
  const isJobAgent = agent.name.startsWith("job-");
  const isAssistedUpdateAgent = agent.role === "assisted_update";
  const isTerminalAgent = agent.type === "terminal";
  const canPromptRename =
    agent.status === "running" && hasDefaultSessionName(agent);
  const promptAgentToRename = React.useCallback(async () => {
    if (renamePromptPending) return;
    setRenamePromptPending(true);
    try {
      await api(`/api/v1/agents/${agent.id}/prompt-rename`, {
        method: "POST",
      });
      toast.success("Asked the agent to set a session name.");
    } catch (err) {
      toast.error("Couldn't reach the agent — try again in a moment.", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setTimeout(() => setRenamePromptPending(false), 1500);
    }
  }, [agent.id, renamePromptPending]);
  const collapsedRepoName = agent.gitContext
    ? (agent.gitContext.repoRoot.split("/").pop() ?? null)
    : (agent.cwd.split("/").pop() ?? null);

  return (
    <React.Fragment>
      <div
        data-testid={`agent-card-${agent.id}`}
        className={cn(
          "border-b border-r-4 border-border px-2 py-2 transition-colors duration-300",
          borderForAgentState(effectiveState),
          isSelected && "bg-muted/60",
          isStopped && "opacity-60"
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5",
            !isStopped && "cursor-pointer"
          )}
          data-testid={`agent-row-${agent.id}`}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("[data-agent-control='true']")) return;
            if (isStopped) return;
            if (connectedAgentId === agent.id) {
              detachTerminal();
              if (isExpanded) toggleAgentDetails(agent.id);
              return;
            }
            if (closeOnSessionAction) onRequestClose?.();
            void attachToAgent(agent);
          }}
        >
          <div className="flex flex-1 min-w-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="min-w-0 flex items-center gap-2 text-left text-sm font-semibold">
                  <AgentTypeIcon
                    type={agent.type}
                    eventType={
                      isTerminalAgent
                        ? null
                        : agent.status === "running"
                          ? agent.latestEvent?.type
                          : null
                    }
                  />
                  <span className="truncate">{agent.name}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>{agent.cwd}</TooltipContent>
            </Tooltip>
            {canPromptRename ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    data-agent-control="true"
                    data-testid={`agent-prompt-rename-${agent.id}`}
                    aria-label="Ask agent to set a session name"
                    className="h-6 w-6 shrink-0 text-muted-foreground/70 hover:text-foreground [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
                    disabled={renamePromptPending}
                    onClick={() => {
                      void promptAgentToRename();
                    }}
                  >
                    <Tag className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Ask agent to name session
                  <br />
                  <span className="text-muted-foreground">
                    Sends a prompt asking the agent to rename itself
                  </span>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>

          {needsAttention ? (
            <Badge
              className="border-status-blocked/45 bg-status-blocked/15 text-status-blocked"
              title={
                agent.lastError ??
                "Agent entered an error state and may need attention."
              }
            >
              Attention
            </Badge>
          ) : null}

          {isJobAgent ? (
            <Badge
              className="border-status-working/45 bg-status-working/15 text-status-working"
              title="Job-spawned agent"
            >
              <AlarmClock className="mr-1 h-3 w-3" />
              Job
            </Badge>
          ) : null}

          {isAssistedUpdateAgent ? (
            <Badge
              className="border-blue-500/35 bg-blue-500/10 text-blue-400"
              title="Agent-assisted Dispatch update"
            >
              <ArrowDownToLine className="mr-1 h-3 w-3" />
              Update
            </Badge>
          ) : null}

          {isStopped && agent.status !== "archiving" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost-primary"
                  data-agent-control="true"
                  className="ml-auto"
                  onClick={() => {
                    if (closeOnSessionAction) onRequestClose?.();
                    void startAgent(agent);
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Resume
                <br />
                <span className="text-muted-foreground">
                  Resume agent session
                </span>
              </TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                data-agent-control="true"
                data-testid={`agent-expand-toggle-${agent.id}`}
                onClick={() => {
                  if (
                    isExpanded &&
                    connectedAgentId &&
                    childAgents.some((c) => c.id === connectedAgentId)
                  ) {
                    detachTerminal();
                  }
                  toggleAgentDetails(agent.id);
                }}
              >
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform duration-200",
                    isExpanded && "rotate-180"
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isExpanded ? "Hide details" : "Show details"}
            </TooltipContent>
          </Tooltip>
        </div>

        {agent.status === "creating" && agent.setupPhase ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-status-working">
            <ActivityBars size={12} className="shrink-0" />
            <span className="truncate font-medium">
              {agent.setupPhase === "worktree"
                ? "Creating worktree…"
                : agent.setupPhase === "env"
                  ? "Copying environment…"
                  : agent.setupPhase === "deps"
                    ? "Installing dependencies…"
                    : agent.setupPhase === "session"
                      ? "Starting session…"
                      : "Setting up…"}
            </span>
          </div>
        ) : null}

        {agent.status === "archiving" ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-orange-400">
            <ActivityBars size={12} className="shrink-0" />
            <span className="truncate font-medium">
              {agent.archivePhase === "stopping"
                ? "Stopping agent…"
                : agent.archivePhase === "worktree-check"
                  ? "Checking worktree…"
                  : agent.archivePhase === "worktree-cleanup"
                    ? "Removing worktree…"
                    : agent.archivePhase === "finalizing"
                      ? "Finalizing…"
                      : "Archiving…"}
            </span>
          </div>
        ) : null}

        {agent.latestEvent && !isTerminalAgent ? (
          isExpanded ? (
            <div className="mt-1 text-xs text-muted-foreground">
              <div className="flex items-baseline">
                <span
                  className={cn(
                    "shrink-0 font-medium",
                    latestEventColor(agent.latestEvent.type)
                  )}
                >
                  {latestEventLabel(agent.latestEvent.type)}
                </span>
                <span className="mx-1.5 shrink-0 text-muted-foreground/70">
                  •
                </span>
                <span className="shrink-0">
                  {formatRelativeTime(agent.latestEvent.updatedAt)}
                </span>
                {collapsedRepoName ? (
                  <RepoLabel
                    agentId={agent.id}
                    repoIconPath={agent.gitContext?.repoIconPath}
                    name={collapsedRepoName}
                  />
                ) : null}
              </div>
              <div className="mt-0.5 leading-relaxed text-muted-foreground">
                {agent.latestEvent.message}
              </div>
            </div>
          ) : (
            <div className="mt-1 flex min-w-0 items-baseline text-xs text-muted-foreground">
              <span
                className={cn(
                  "shrink-0 font-medium",
                  latestEventColor(agent.latestEvent.type)
                )}
              >
                {latestEventLabel(agent.latestEvent.type)}
              </span>
              <span className="mx-1.5 shrink-0 text-muted-foreground/70">
                •
              </span>
              <span className="shrink-0">
                {formatRelativeTime(agent.latestEvent.updatedAt)}
              </span>
              {collapsedRepoName ? (
                <RepoLabel
                  agentId={agent.id}
                  repoIconPath={agent.gitContext?.repoIconPath}
                  name={collapsedRepoName}
                />
              ) : null}
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
              <AgentCardDetails
                agent={agent}
                agents={agents}
                childAgents={childAgents}
                selectedAgentId={selectedAgentId}
                agentVisualState={getVisualState}
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
                enabledAgentTypes={enabledAgentTypes}
                enabledIdes={enabledIdes}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </React.Fragment>
  );
}
