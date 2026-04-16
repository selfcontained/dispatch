import React from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  AlarmClock,
  Copy,
  Folder,
  FolderGit2,
  FolderTree,
  GitBranch,
  Loader2,
  Play,
  Pause,
} from "lucide-react";

import { AgentMeta, FrontTruncatedValue } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import {
  latestEventLabel,
  latestEventColor,
  formatRelativeTime,
} from "@/components/app/agent-event-utils";
import {
  type FeedbackDetailState,
  ParentFeedbackPanel,
} from "@/components/app/feedback-panel";
import { PersonaLauncher } from "@/components/app/persona-launcher";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatePresence, motion } from "framer-motion";
import { useCopyText } from "@/hooks/use-copy";
import { type AgentType } from "@/lib/agent-types";
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
};

function CompactMetaRow({
  label,
  icon,
  value,
  mono = false,
  truncateStart = false,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  mono?: boolean;
  truncateStart?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground/75" title={label}>
        {icon ?? (
          <span className="text-[10px] uppercase tracking-wide">{label}</span>
        )}
      </span>
      <div className="min-w-0 flex-1 text-left">
        {truncateStart ? (
          <FrontTruncatedValue
            value={value}
            mono={mono}
            className="text-left text-foreground"
            tooltipClassName="max-w-[420px]"
          />
        ) : (
          <div
            className={cn(
              "text-foreground break-all",
              mono && "font-mono text-[11px]"
            )}
          >
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

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
}: AgentCardProps): JSX.Element {
  const state = getVisualState(agent);
  const isSelected = selectedAgentId === agent.id;
  const isStopped = state === "stopped";
  const isExpanded = expandedAgentId === agent.id;
  const fullAccessEnabled = isFullAccessEnabled(agent);
  const [worktreePathCopied, copyWorktreePath] = useCopyText();
  const needsAttention = agent.status === "error";
  const isJobAgent = agent.name.startsWith("job-");
  const sidebarBaseBranch = agent.baseBranch ?? "main";

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
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="min-w-0 flex flex-1 items-center gap-2 text-left text-sm font-semibold">
                <AgentTypeIcon
                  type={agent.type}
                  eventType={
                    agent.status === "running" ? agent.latestEvent?.type : null
                  }
                />
                <span className="truncate">{agent.name}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{agent.cwd}</TooltipContent>
          </Tooltip>

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
                  // If collapsing while a child persona is connected, detach it
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
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
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
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
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

        {agent.latestEvent ? (
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
              <span className="mx-1.5 shrink-0 text-muted-foreground/70">
                •
              </span>
              <span className="min-w-0 truncate">
                {agent.latestEvent.message}
              </span>
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
              <div className="flex flex-col gap-3 px-0 pb-0.5 pt-0.5">
                <div className="space-y-1.5">
                  <div className="space-y-2 rounded-xl border border-border/60 bg-background/25 px-3 py-3 text-xs text-muted-foreground">
                    {agent.gitContext?.isWorktree ? (
                      <>
                        <CompactMetaRow
                          label="Repo"
                          icon={<FolderGit2 className="h-3.5 w-3.5" />}
                          value={
                            agent.gitContext.repoRoot.split("/").pop() ??
                            agent.gitContext.repoRoot
                          }
                        />
                        <div className="flex items-start justify-between gap-3">
                          <span
                            className="shrink-0 text-muted-foreground/75"
                            title="Branch"
                          >
                            <GitBranch className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1 text-left">
                            <div className="text-muted-foreground">
                              <FrontTruncatedValue
                                value={sidebarBaseBranch}
                                mono
                                className="text-left text-muted-foreground"
                                tooltipClassName=""
                                tooltipValue={`Base branch: ${sidebarBaseBranch}`}
                              />
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 pl-2">
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">
                                ↳
                              </span>
                              <FrontTruncatedValue
                                value={agent.gitContext.branch}
                                mono
                                className="text-left"
                                tooltipValue={`Working branch: ${agent.gitContext.branch}`}
                              />
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <CompactMetaRow
                          label="Working dir"
                          icon={<Folder className="h-3.5 w-3.5" />}
                          value={agent.cwd}
                          mono
                          truncateStart
                        />
                        {agent.gitContext ? (
                          <CompactMetaRow
                            label="Branch"
                            icon={<GitBranch className="h-3.5 w-3.5" />}
                            value={agent.gitContext.branch}
                            mono
                            truncateStart
                          />
                        ) : null}
                      </>
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      {agent.gitContext?.isWorktree && agent.cwd ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                agent.cwd && copyWorktreePath(agent.cwd)
                              }
                              className="group h-auto gap-1 rounded-full border border-border bg-muted/35 px-2 py-0.5 text-[10px] font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            >
                              {worktreePathCopied ? (
                                <Check className="h-3 w-3 text-status-done" />
                              ) : (
                                <>
                                  <FolderTree className="h-3 w-3 group-hover:hidden" />
                                  <Copy className="hidden h-3 w-3 group-hover:block" />
                                </>
                              )}
                              <span>Worktree</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[420px] break-all">
                            {agent.cwd}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span />
                      )}
                      <div
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]",
                          fullAccessEnabled
                            ? "border border-status-waiting/35 bg-status-waiting/10 text-status-waiting"
                            : "border border-border bg-muted/40 text-muted-foreground"
                        )}
                      >
                        {fullAccessEnabled ? (
                          <AlertTriangle className="h-3 w-3" />
                        ) : null}
                        <span>
                          {fullAccessEnabled ? "Full access" : "Sandboxed"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {agent.lastError ? (
                  <AgentMeta label="Last error" value={agent.lastError} />
                ) : null}
                {agent.persona ? (
                  <div className="flex items-center gap-1.5">
                    <span className="uppercase tracking-wide text-[10px] text-muted-foreground/80">
                      Persona
                    </span>
                    <Badge variant="running">{agent.persona}</Badge>
                    {agent.parentAgentId ? (
                      <span className="text-[10px] text-muted-foreground">
                        from{" "}
                        {agents.find((a) => a.id === agent.parentAgentId)
                          ?.name ?? agent.parentAgentId.slice(-6)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {!agent.persona ? (
                <div className="flex flex-col gap-3 px-0 pb-1">
                  <ParentFeedbackPanel
                    parentAgentId={agent.id}
                    sendTerminalInput={sendTerminalInput}
                    isConnected={connectedAgentId === agent.id}
                    onRequestClose={onRequestClose}
                    closeOnSessionAction={closeOnSessionAction}
                    onOpenDetail={onOpenFeedbackDetail}
                    activeDetailItemId={
                      feedbackDetailState?.parentAgentId === agent.id &&
                      "itemId" in feedbackDetailState
                        ? feedbackDetailState.itemId
                        : null
                    }
                    childAgents={childAgents}
                    selectedAgentId={selectedAgentId}
                    agentVisualState={getVisualState}
                    detachTerminal={detachTerminal}
                    attachToAgent={attachToAgent}
                  />
                  <div className="flex min-h-9 items-center justify-between gap-2 pt-2">
                    <div className="min-h-9 min-w-0 flex items-center">
                      <PersonaLauncher
                        agent={agent}
                        enabledAgentTypes={enabledAgentTypes}
                        sendTerminalInput={sendTerminalInput}
                        disabled={
                          connectedAgentId !== agent.id ||
                          isStopped ||
                          agent.status === "archiving"
                        }
                      />
                      {/* Keep review visible for every parent agent; lifecycle controls stay on the right. */}
                    </div>
                    <div className="flex h-9 shrink-0 items-center gap-[18px]">
                      {isStopped && agent.status !== "archiving" ? (
                        <Button
                          size="sm"
                          variant="ghost-primary"
                          className="h-8 w-8 rounded-full border border-status-done/35 bg-status-done/10 p-0"
                          aria-label="Resume"
                          title="Resume"
                          onClick={() => {
                            if (closeOnSessionAction) onRequestClose?.();
                            void startAgent(agent);
                          }}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      ) : !isStopped && agent.status !== "archiving" ? (
                        <Button
                          size="sm"
                          variant="ghost-warning"
                          className="h-8 w-8 rounded-full border border-status-waiting/35 bg-status-waiting/10 p-0"
                          aria-label="Pause"
                          title="Pause"
                          onClick={() => {
                            setStopTarget(agent);
                            setStopConfirmOpen(true);
                          }}
                        >
                          <Pause className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost-destructive"
                        className="h-8 w-8 rounded-full border border-status-blocked/35 bg-status-blocked/10 p-0"
                        data-testid={`agent-archive-${agent.id}`}
                        aria-label="Archive"
                        title="Archive"
                        disabled={
                          agent.status === "archiving" ||
                          agent.status === "creating"
                        }
                        onClick={() => {
                          setDeleteTarget(agent);
                          setDeleteConfirmOpen(true);
                        }}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </React.Fragment>
  );
}
