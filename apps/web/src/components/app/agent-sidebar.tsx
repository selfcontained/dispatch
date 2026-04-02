import React from "react";
import {
  AlertTriangle,
  Activity,
  Archive,
  BookOpenText,
  ChevronDown,
  ChevronLeft,
  Loader2,
  Play,
  Square,
  Settings,
  X
} from "lucide-react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { ParentFeedbackPanel } from "@/components/app/feedback-panel";
import { PersonaLauncher } from "@/components/app/persona-launcher";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
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
  onOpenDocs: () => void;
  onOpenActivity: () => void;
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
  onOpenDocs,
  onOpenActivity,
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
  onRequestClose,
  closeOnSessionAction = false,
  closeButtonIcon = "x",
  className
}: AgentSidebarContentProps): JSX.Element {
  const defaultCreateType: AgentType = lastUsedAgentType && enabledAgentTypes.includes(lastUsedAgentType)
    ? lastUsedAgentType
    : enabledAgentTypes[0] ?? "codex";

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
            <LayoutGroup>
            {agents.filter((a) => !a.parentAgentId).map((agent) => {
              const childAgents = agents.filter((a) => a.parentAgentId === agent.id);
              const state = agentVisualState(agent);
              const isSelected = selectedAgentId === agent.id;
              const isStopped = state === "stopped";
              const isActive = state === "active";
              const isExpanded = isActive || expandedAgentId === agent.id;
              const fullAccessEnabled = isFullAccessEnabled(agent);
              const needsAttention = agent.status === "error";

              return (
                <React.Fragment key={agent.id}>
                <motion.div
                  layout
                  transition={{ duration: 0.3, ease: "easeInOut" }}
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
                      if (target.closest("[data-agent-control='true']")) {
                        return;
                      }
                      if (isStopped) {
                        return;
                      }
                      if (isActive) {
                        detachTerminal();
                        return;
                      }
                      if (closeOnSessionAction) {
                        onRequestClose?.();
                      }
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
                            <Square className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Stop<br /><span className="text-muted-foreground">End agent session</span></TooltipContent>
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
                          disabled={isActive}
                          onClick={() => {
                            if (isActive) {
                              return;
                            }
                            toggleAgentDetails(agent.id);
                          }}
                        >
                          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", isExpanded && "rotate-180", isActive && "opacity-40")} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{isActive ? "Attached agent stays open" : isExpanded ? "Hide details" : "Show details"}</TooltipContent>
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
                            {!isStopped && !agent.persona && sendTerminalInput && connectedAgentId === agent.id ? (
                              <PersonaLauncher
                                agent={agent}
                                sendTerminalInput={sendTerminalInput}
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
                            />
                          </div>
                        ) : null}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>
                {childAgents.map((child) => {
                  const childState = agentVisualState(child);
                  const childIsSelected = selectedAgentId === child.id;
                  const childIsStopped = childState === "stopped";
                  const childIsActive = childState === "active";
                  const childIsExpanded = childIsActive || expandedAgentId === child.id;

                  return (
                    <motion.div
                      key={child.id}
                      layout
                      transition={{ duration: 0.3, ease: "easeInOut" }}
                      data-testid={`agent-card-${child.id}`}
                      className={cn(
                        "border-b border-r-4 border-border pl-5 pr-2 py-2 transition-colors duration-300",
                        borderForAgentState(childState),
                        childIsSelected && "bg-muted/60",
                        childIsStopped && "opacity-60"
                      )}
                    >
                      <div
                        className={cn("flex items-center gap-1.5", !childIsStopped && "cursor-pointer")}
                        data-testid={`agent-row-${child.id}`}
                        onClick={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest("[data-agent-control='true']")) return;
                          if (childIsStopped) return;
                          if (childIsActive) { detachTerminal(); return; }
                          if (closeOnSessionAction) onRequestClose?.();
                          void attachToAgent(child);
                        }}
                      >
                        <div className="min-w-0 flex flex-1 items-center gap-2 text-left text-sm font-semibold">
                          <AgentTypeIcon type={child.type} eventType={child.status === "running" ? child.latestEvent?.type : null} />
                          <span className="truncate">{child.name}</span>
                          {child.persona ? (
                            <Badge variant="running" className="text-[9px] shrink-0">{child.persona}</Badge>
                          ) : null}
                        </div>
                        {childIsStopped ? (
                          <button data-agent-control="true" aria-label="Resume agent" className="p-1 text-muted-foreground/60 hover:text-foreground transition-colors" onClick={() => startAgent(child)}><Play className="h-3.5 w-3.5" /></button>
                        ) : (
                          <button data-agent-control="true" aria-label="Stop agent" className="p-1 text-muted-foreground/60 hover:text-foreground transition-colors" onClick={() => { setStopTarget(child); setStopConfirmOpen(true); }}><Square className="h-3.5 w-3.5" /></button>
                        )}
                        <button data-agent-control="true" aria-label="Archive agent" data-testid={`agent-archive-${child.id}`} className="p-1 text-muted-foreground/60 hover:text-foreground transition-colors" onClick={() => { setDeleteTarget(child); setDeleteConfirmOpen(true); }}><Archive className="h-3.5 w-3.5" /></button>
                      </div>
                      {child.latestEvent ? (
                        childIsExpanded ? (
                          <div className="mt-1 flex flex-wrap items-center gap-x-0 text-xs text-muted-foreground">
                            <span className={cn("font-medium", child.latestEvent.type === "working" ? "text-status-working" : child.latestEvent.type === "blocked" ? "text-status-blocked" : child.latestEvent.type === "waiting_user" ? "text-status-waiting" : child.latestEvent.type === "done" ? "text-status-done" : "text-status-idle")}>{child.latestEvent.type === "working" ? "Working" : child.latestEvent.type === "blocked" ? "Blocked" : child.latestEvent.type === "waiting_user" ? "Waiting" : child.latestEvent.type === "done" ? "Done" : "Idle"}</span>
                            <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
                            <span className="min-w-0 truncate">{child.latestEvent.message}</span>
                          </div>
                        ) : null
                      ) : null}
                    </motion.div>
                  );
                })}
              </React.Fragment>
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
          onClick={onOpenActivity}
          data-testid="activity-button"
          className="flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground md:text-xs"
        >
          <Activity className="h-4 w-4 md:h-3.5 md:w-3.5" />
          Activity
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
