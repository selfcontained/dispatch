import {
  AlertTriangle,
  BookOpenText,
  ChevronLeft,
  Archive,
  BotMessageSquare,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Square,
  Settings,
  X
} from "lucide-react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LayoutGroup, motion } from "framer-motion";
import { cn } from "@/lib/utils";

type AgentSidebarSharedProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  overflowAgentId: string | null;
  onOpenCreateDialog: () => void;
  onOpenDocs: () => void;
  onOpenSettings: () => void;
  setOverflowAgentId: (value: string | null | ((current: string | null) => string | null)) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (agent: Pick<Agent, "agentArgs" | "fullAccess">) => boolean;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  stopAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
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
  overflowAgentId,
  onOpenCreateDialog,
  onOpenDocs,
  onOpenSettings,
  setOverflowAgentId,
  setDeleteTarget,
  setDeleteConfirmOpen,
  agentVisualState,
  borderForAgentState,
  toggleAgentDetails,
  isFullAccessEnabled,
  detachTerminal,
  attachToAgent,
  stopAgent,
  startAgent,
  onRequestClose,
  closeOnSessionAction = false,
  closeButtonIcon = "x",
  className
}: AgentSidebarContentProps): JSX.Element {
  const agentTypeLabel = (type?: string): string => {
    if (type === "claude") {
      return "Claude";
    }
    if (type === "codex" || !type) {
      return "Codex";
    }
    if (type === "opencode") {
      return "OpenCode";
    }
    return type;
  };

  const latestEventLabel = (type: NonNullable<Agent["latestEvent"]>["type"]): string => {
    if (type === "waiting_user") {
      return "Waiting";
    }
    if (type === "working") {
      return "Working";
    }
    if (type === "blocked") {
      return "Blocked";
    }
    if (type === "done") {
      return "Done";
    }
    return "Idle";
  };

  const latestEventColor = (type: NonNullable<Agent["latestEvent"]>["type"]): string => {
    if (type === "working") return "text-status-working";
    if (type === "blocked") return "text-status-blocked";
    if (type === "waiting_user") return "text-status-waiting";
    if (type === "done") return "text-status-done";
    return "text-foreground/80";
  };

  const formatRelativeTime = (value: string): string => {
    const date = new Date(value);
    const time = date.getTime();
    if (!Number.isFinite(time)) {
      return "";
    }

    const deltaSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (deltaSeconds < 60) {
      return "just now";
    }
    if (deltaSeconds < 3600) {
      return `${Math.floor(deltaSeconds / 60)}m ago`;
    }
    if (deltaSeconds < 86_400) {
      return `${Math.floor(deltaSeconds / 3600)}h ago`;
    }
    return `${Math.floor(deltaSeconds / 86_400)}d ago`;
  };

  return (
    <aside data-testid="agent-sidebar" className={cn("flex h-full min-h-0 w-full flex-col border-r-2 border-border bg-card text-foreground", className)}>
      <div className="flex h-14 items-center px-3 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center">
          <img src="/brand-full-logo.svg" alt="Dispatch" className="h-7 w-auto max-w-[180px] object-contain" />
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
          <Button size="sm" variant="primary" onClick={onOpenCreateDialog} data-testid="create-agent-button">
            <BotMessageSquare className="mr-1 h-3.5 w-3.5" /> Create
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TooltipProvider delayDuration={120}>
          {agents.length === 0 ? (
            <div data-testid="no-agents-message" className="p-4 text-sm text-muted-foreground">No agents yet.</div>
          ) : (
            <LayoutGroup>
            {agents.map((agent) => {
              const state = agentVisualState(agent);
              const isSelected = selectedAgentId === agent.id;
              const isStopped = state === "stopped";
              const isActive = state === "active";
              const isExpanded = isSelected;
              const fullAccessEnabled = isFullAccessEnabled(agent);
              const needsAttention = agent.status === "error";

              return (
                <motion.div
                  key={agent.id}
                  layout
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  data-testid={`agent-card-${agent.id}`}
                  className={cn(
                    "border-b border-r-4 border-border px-2 py-2 transition-colors duration-300",
                    borderForAgentState(state),
                    isActive && "bg-status-working/10",
                    isStopped && "opacity-60",
                    isSelected && "bg-muted/60"
                  )}
                >
                  <div
                    className="flex cursor-pointer items-center gap-1.5"
                    onClick={(event) => {
                      const target = event.target as HTMLElement;
                      if (target.closest("[data-agent-control='true']")) {
                        return;
                      }
                      toggleAgentDetails(agent.id);
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          data-agent-control="true"
                          className="min-w-0 flex flex-1 items-center gap-2 text-left text-sm font-semibold"
                          onClick={() => toggleAgentDetails(agent.id)}
                        >
                          <AgentTypeIcon type={agent.type} eventType={agent.status === "running" ? agent.latestEvent?.type : null} />
                          <span className="truncate">{agent.name}</span>
                        </button>
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

                    {isStopped ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost-primary"
                            data-agent-control="true"
                            onClick={() => {
                              if (closeOnSessionAction) {
                                onRequestClose?.();
                              }
                              void startAgent(agent);
                            }}
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Resume<br /><span className="text-muted-foreground">Start agent session</span></TooltipContent>
                      </Tooltip>
                    ) : (
                      <>
                        {isActive ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost-info"
                                data-agent-control="true"
                                onClick={detachTerminal}
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Unfocus<br /><span className="text-muted-foreground">Agent keeps running</span></TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                data-agent-control="true"
                                onClick={() => {
                                  if (closeOnSessionAction) {
                                    onRequestClose?.();
                                  }
                                  void attachToAgent(agent);
                                }}
                              >
                                <EyeOff className="h-3.5 w-3.5 opacity-40" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Focus<br /><span className="text-muted-foreground">Watch this agent</span></TooltipContent>
                          </Tooltip>
                        )}

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost-warning"
                              data-agent-control="true"
                              onClick={() => void stopAgent(agent)}
                            >
                              <Square className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Stop<br /><span className="text-muted-foreground">End agent session</span></TooltipContent>
                        </Tooltip>
                      </>
                    )}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost-destructive"
                          data-agent-control="true"
                          className="ml-auto"
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

                  <div
                    className={cn(
                      "grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-300 ease-out",
                      isExpanded ? "mt-2 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0"
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="px-3 pt-1">
                        <div className="grid gap-2 text-xs text-muted-foreground">
                          {agent.gitContext?.isWorktree ? (
                            <>
                              <AgentMeta label="Repo" value={agent.gitContext.repoRoot.split("/").pop() ?? agent.gitContext.repoRoot} />
                              <AgentMeta label="Worktree" value={agent.cwd} mono truncateStart />
                              <AgentMeta label="Branch" value={agent.gitContext.branch} mono truncateStart />
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
                          <AgentMeta label="Agent type" value={agentTypeLabel(agent.type)} />
                          <div className="grid gap-1">
                            <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">
                              Full access
                            </div>
                            <div
                              className={cn(
                                "inline-flex w-fit items-center gap-1.5 px-1.5 py-0.5 text-foreground",
                                fullAccessEnabled &&
                                  "border border-status-waiting/45 bg-status-waiting/15 text-status-waiting"
                              )}
                            >
                              {fullAccessEnabled ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
                              <span>{fullAccessEnabled ? "Enabled" : "Disabled"}</span>
                            </div>
                          </div>
                          {agent.lastError ? <AgentMeta label="Last error" value={agent.lastError} /> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
            </LayoutGroup>
          )}
        </TooltipProvider>
      </div>
      <div className="space-y-8 border-t border-border px-3 py-8 pb-[max(2rem,env(safe-area-inset-bottom))] md:space-y-6 md:py-6 md:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <button
          onClick={onOpenDocs}
          data-testid="docs-button"
          className="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground md:text-xs"
        >
          <BookOpenText className="h-4 w-4 md:h-3.5 md:w-3.5" />
          Documentation
        </button>
        <button
          onClick={onOpenSettings}
          data-testid="settings-button"
          className="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground md:text-xs"
        >
          <Settings className="h-4 w-4 md:h-3.5 md:w-3.5" />
          Settings
        </button>
      </div>
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
