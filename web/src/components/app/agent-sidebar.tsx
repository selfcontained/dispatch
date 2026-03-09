import {
  AlertTriangle,
  ChevronLeft,
  EllipsisVertical,
  FolderGit2,
  GitBranch,
  Monitor,
  MonitorOff,
  Play,
  Plus,
  Square,
  X
} from "lucide-react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type AgentSidebarSharedProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  overflowAgentId: string | null;
  onOpenCreateDialog: () => void;
  onOpenEditWorktreeDialog: (agent: Agent) => void;
  setOverflowAgentId: (value: string | null | ((current: string | null) => string | null)) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (agent: Pick<Agent, "codexArgs">) => boolean;
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
  onOpenEditWorktreeDialog,
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
    return type;
  };

  return (
    <aside className={cn("flex h-full min-h-0 w-full flex-col border-r-2 border-border bg-card text-foreground", className)}>
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
          <Button size="sm" variant="primary" onClick={onOpenCreateDialog}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Create
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <TooltipProvider delayDuration={120}>
          {agents.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No agents yet.</div>
          ) : (
            agents.map((agent) => {
              const state = agentVisualState(agent);
              const isSelected = selectedAgentId === agent.id;
              const isStopped = state === "stopped";
              const isActive = state === "active";
              const isExpanded = isSelected;
              const fullAccessEnabled = isFullAccessEnabled(agent);
              const needsAttention = agent.status === "error";

              return (
                <div
                  key={agent.id}
                  className={cn(
                    "border-b border-r-2 border-border px-2 py-2",
                    borderForAgentState(state),
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
                          <AgentTypeIcon type={agent.type} />
                          <span className="truncate">{agent.name}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{agent.cwd}</TooltipContent>
                    </Tooltip>

                    {needsAttention ? (
                      <Badge
                        className="border-red-400/45 bg-red-500/15 text-red-200"
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
                            variant="ghost"
                            className="text-emerald-300 hover:bg-emerald-500/15 hover:text-emerald-200"
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
                        <TooltipContent>Play (start session)</TooltipContent>
                      </Tooltip>
                    ) : (
                      <>
                        {isActive ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="text-sky-300 hover:bg-sky-500/15 hover:text-sky-200"
                                data-agent-control="true"
                                onClick={detachTerminal}
                              >
                                <MonitorOff className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Detach from session</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="text-emerald-300 hover:bg-emerald-500/15 hover:text-emerald-200"
                                data-agent-control="true"
                                onClick={() => {
                                  if (closeOnSessionAction) {
                                    onRequestClose?.();
                                  }
                                  void attachToAgent(agent);
                                }}
                              >
                                <Monitor className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Attach to session</TooltipContent>
                          </Tooltip>
                        )}

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="text-red-300 hover:bg-red-500/15 hover:text-red-200"
                              data-agent-control="true"
                              onClick={() => void stopAgent(agent)}
                            >
                              <Square className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Stop session</TooltipContent>
                        </Tooltip>
                      </>
                    )}

                    <div className="relative ml-auto" data-overflow-root="true">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            data-agent-control="true"
                            onClick={() =>
                              setOverflowAgentId((current) => (current === agent.id ? null : agent.id))
                            }
                          >
                            <EllipsisVertical className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>More actions</TooltipContent>
                      </Tooltip>

                      {overflowAgentId === agent.id ? (
                        <div className="absolute right-0 top-9 z-30 min-w-[180px] rounded-md border-2 border-border bg-card p-1.5 text-foreground shadow-xl">
                          <button
                            data-agent-control="true"
                            className="w-full rounded-sm border border-transparent px-2 py-1.5 text-left text-sm hover:border-border hover:bg-muted/70"
                            onClick={() => {
                              setOverflowAgentId(null);
                              onOpenEditWorktreeDialog(agent);
                            }}
                          >
                            Worktree mode
                          </button>
                          {!isStopped ? (
                            <button
                              data-agent-control="true"
                              className="w-full rounded-sm border border-transparent px-2 py-1.5 text-left text-sm text-red-300 hover:border-border hover:bg-muted/70"
                              onClick={() => {
                                setOverflowAgentId(null);
                                void stopAgent(agent);
                              }}
                            >
                              Stop session
                            </button>
                          ) : null}
                          <button
                            data-agent-control="true"
                            className="w-full rounded-sm border border-transparent px-2 py-1.5 text-left text-sm text-red-300 hover:border-border hover:bg-muted/70"
                            onClick={() => {
                              setOverflowAgentId(null);
                              setDeleteTarget(agent);
                              setDeleteConfirmOpen(true);
                            }}
                          >
                            Delete agent
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className={cn(
                      "grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-300 ease-out",
                      isExpanded ? "mt-2 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0"
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="px-3 pt-1">
                        <div className="grid gap-2 text-xs text-muted-foreground">
                          <AgentMeta label="Working dir" value={agent.cwd} mono />
                          <div className="grid gap-1">
                            <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">Git</div>
                            {agent.gitContext ? (
                              <div className="grid gap-1 text-foreground">
                                <div className="inline-flex items-center gap-1.5">
                                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span>{agent.gitContext.branch}</span>
                                </div>
                                <div className="inline-flex items-center gap-1.5">
                                  <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span>
                                    {agent.gitContext.isWorktree
                                      ? `worktree: ${agent.gitContext.worktreeName}`
                                      : "main repository"}
                                  </span>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span>
                                        <Badge
                                          variant="default"
                                          className="ml-1 h-5 border border-border bg-transparent px-1.5 text-[10px] uppercase text-muted-foreground"
                                        >
                                          {agent.gitContext.isWorktree ? "Worktree" : "Repository"}
                                        </Badge>
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="max-w-[240px] text-xs">
                                      {agent.gitContext.isWorktree
                                        ? "This agent is currently in a linked git worktree checkout."
                                        : "This agent is currently in the primary repository checkout."}
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1.5 text-foreground">
                                <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>Not a git repository</span>
                              </div>
                            )}
                          </div>
                          <AgentMeta label="Agent type" value={agentTypeLabel(agent.type)} />
                          <div className="grid gap-1">
                            <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">
                              Full access
                            </div>
                            <div
                              className={cn(
                                "inline-flex w-fit items-center gap-1.5 px-1.5 py-0.5 text-foreground",
                                fullAccessEnabled &&
                                  "border border-orange-400/45 bg-orange-500/15 text-orange-200"
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
                </div>
              );
            })
          )}
        </TooltipProvider>
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
