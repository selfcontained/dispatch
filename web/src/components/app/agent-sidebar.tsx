import {
  ChevronLeft,
  EllipsisVertical,
  Pause,
  Play,
  Plus,
  Square
} from "lucide-react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AgentSidebarProps = {
  leftOpen: boolean;
  agents: Agent[];
  selectedAgentId: string | null;
  overflowAgentId: string | null;
  setLeftOpen: (open: boolean) => void;
  setCreateOpen: (open: boolean) => void;
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
  overflowAgentId,
  setLeftOpen,
  setCreateOpen,
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
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Create
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
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
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("[data-agent-control='true']")) {
                      return;
                    }
                    toggleAgentDetails(agent.id);
                  }}
                  className={cn(
                    "border-b border-r-2 border-border px-2 py-2",
                    borderForAgentState(state),
                    isSelected && "bg-muted/60",
                    "cursor-pointer"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <button
                      data-agent-control="true"
                      className="min-w-0 flex flex-1 items-center gap-2 text-left text-sm font-semibold"
                      onClick={() => toggleAgentDetails(agent.id)}
                      title={agent.cwd}
                    >
                      <AgentTypeIcon type={agent.type} />
                      <span className="truncate">{agent.name}</span>
                    </button>

                    {needsAttention ? (
                      <Badge
                        className="border-red-400/45 bg-red-500/15 text-red-200"
                        title={agent.lastError ?? "Agent entered an error state and may need attention."}
                      >
                        Attention
                      </Badge>
                    ) : null}

                    <button
                      type="button"
                      data-agent-control="true"
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        isActive
                          ? "bg-emerald-500/15 text-emerald-300"
                          : isStopped
                            ? "bg-zinc-500/15 text-zinc-300"
                            : "bg-zinc-500/15 text-zinc-300"
                      )}
                    >
                      {isActive ? "Active" : agent.status === "running" ? "Detached" : agent.status}
                    </button>

                    {isStopped ? (
                      <Button
                        size="icon"
                        data-agent-control="true"
                        onClick={() => void startAgent(agent)}
                        title="Start agent"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <>
                        {isActive ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            data-agent-control="true"
                            onClick={detachTerminal}
                            title="Pause (detach terminal)"
                          >
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            data-agent-control="true"
                            onClick={() => void attachToAgent(agent)}
                            title="Play (attach terminal)"
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        )}

                        {isActive ? (
                          <Button
                            size="icon"
                            variant="destructive"
                            data-agent-control="true"
                            onClick={() => void stopAgent(agent)}
                            title="Stop agent"
                          >
                            <Square className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                      </>
                    )}

                    <div className="relative ml-auto" data-overflow-root="true">
                      <Button
                        size="icon"
                        variant="ghost"
                        data-agent-control="true"
                        title="More actions"
                        onClick={() =>
                          setOverflowAgentId((current) => (current === agent.id ? null : agent.id))
                        }
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>

                      {overflowAgentId === agent.id ? (
                        <div className="absolute right-0 top-9 z-30 min-w-[180px] rounded-md border-2 border-border bg-card p-1.5 text-foreground shadow-xl">
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
                          <AgentMeta label="Full access" value={fullAccessEnabled ? "Enabled" : "Disabled"} />
                          {agent.lastError ? <AgentMeta label="Last error" value={agent.lastError} /> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
