import { AlertTriangle, ChevronLeft, EllipsisVertical, Monitor, MonitorOff, Play, Plus, Square } from "lucide-react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState, type WorktreeMode } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type AgentSidebarProps = {
  leftOpen: boolean;
  agents: Agent[];
  selectedAgentId: string | null;
  selectedAgentWorktreeMode: WorktreeMode | null;
  selectedAgentWorktreeLoading: boolean;
  overflowAgentId: string | null;
  setLeftOpen: (open: boolean) => void;
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

export function AgentSidebar({
  leftOpen,
  agents,
  selectedAgentId,
  selectedAgentWorktreeMode,
  selectedAgentWorktreeLoading,
  overflowAgentId,
  setLeftOpen,
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
  startAgent
}: AgentSidebarProps): JSX.Element {
  const worktreeModeLabel = (mode: WorktreeMode): string => {
    if (mode === "auto") {
      return "Auto";
    }
    if (mode === "off") {
      return "Off";
    }
    return "On";
  };

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
    <div
      className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: leftOpen ? 320 : 0 }}
    >
      <aside className="flex h-full min-h-0 w-[320px] flex-col border-r-2 border-border bg-card text-foreground">
        <div className="flex h-14 items-center px-3">
          <div className="text-lg font-semibold tracking-wide">Dispatch</div>
          <div className="ml-auto">
            <Button size="icon" variant="ghost" onClick={() => setLeftOpen(false)} title="Close sidebar">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex h-14 items-center border-b border-border px-3">
          <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Agents</div>
          <div className="ml-auto flex items-center">
            <Button size="sm" variant="primary" onClick={onOpenCreateDialog}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Create
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
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
                            onClick={() => void startAgent(agent)}
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
                                onClick={() => void attachToAgent(agent)}
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
                          <AgentMeta label="Agent type" value={agentTypeLabel(agent.type)} />
                          <AgentMeta
                            label="Worktree mode"
                            value={
                              isSelected
                                ? selectedAgentWorktreeLoading
                                  ? "Loading..."
                                  : worktreeModeLabel(selectedAgentWorktreeMode ?? "off")
                                : "Select agent"
                            }
                          />
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
    </div>
  );
}
