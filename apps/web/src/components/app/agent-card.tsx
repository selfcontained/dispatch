import React from "react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentCardActions } from "@/components/app/agent-card-actions";
import { AgentCardDetails } from "@/components/app/agent-card-details";
import { AgentCardHeader } from "@/components/app/agent-card-header";
import {
  AgentCardLatestEvent,
  AgentCardPhaseStatus,
} from "@/components/app/agent-card-status";
import { ChildAgentRow } from "@/components/app/child-agent-row";
import { useAgentDiffStats } from "@/hooks/use-agent-diff-stats";
import { useCopyText } from "@/hooks/use-copy";
import { SessionSettingsDialog } from "@/components/app/session-settings-dialog";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { AnimatePresence, motion } from "framer-motion";

import { type AgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";

type AgentCardNativeDragHandlers = Partial<{
  dragstart: (event: DragEvent) => void;
  dragenter: (event: DragEvent) => void;
  dragover: (event: DragEvent) => void;
  dragleave: (event: DragEvent) => void;
  drop: (event: DragEvent) => void;
}>;

type AgentCardContainerProps = {
  "aria-describedby"?: string;
  className?: string;
  draggable?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  tabIndex?: number;
  nativeDragHandlers?: AgentCardNativeDragHandlers;
};

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
  openSubmittedReview: (agent: Agent) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  connectedAgentId?: string | null;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
  enabledAgentTypes: AgentType[];
  enabledIdes: IdeType[];
  containerProps?: AgentCardContainerProps;
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
  openSubmittedReview,
  setDeleteTarget,
  setDeleteConfirmOpen,
  setStopTarget,
  setStopConfirmOpen,
  connectedAgentId,
  onRequestClose,
  closeOnSessionAction = false,
  enabledAgentTypes,
  enabledIdes,
  containerProps,
}: AgentCardProps): JSX.Element {
  const {
    className: containerClassName,
    nativeDragHandlers,
    ...rootProps
  } = containerProps ?? {};
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const state = getVisualState(agent);
  const hasActiveChild = childAgents.some(
    (child) => child.id === connectedAgentId
  );
  const effectiveState: AgentVisualState = hasActiveChild ? "idle" : state;
  const isSelected = selectedAgentId === agent.id && !hasActiveChild;
  const isStopped = state === "stopped";
  const isExpanded = expandedAgentId === agent.id;
  const fullAccessEnabled = isFullAccessEnabled(agent);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  // Owned here rather than in AgentCardDetails so the copy confirmation is not
  // lost when the details panel unmounts on collapse.
  const [worktreePathCopied, copyWorktreePath] = useCopyText();
  const isTerminalAgent = agent.type === "terminal";
  const { diffStats, refresh: refreshDiffStats } = useAgentDiffStats(
    agent.id,
    isExpanded
  );

  React.useEffect(() => {
    const node = rootRef.current;
    if (!node || !nativeDragHandlers) return;

    const entries = Object.entries(nativeDragHandlers) as Array<
      [keyof AgentCardNativeDragHandlers, (event: DragEvent) => void]
    >;
    entries.forEach(([eventName, handler]) => {
      node.addEventListener(eventName, handler);
    });
    return () => {
      entries.forEach(([eventName, handler]) => {
        node.removeEventListener(eventName, handler);
      });
    };
  }, [nativeDragHandlers]);

  return (
    <React.Fragment>
      <motion.div
        ref={rootRef}
        {...rootProps}
        layout="position"
        transition={{ layout: { duration: 0.18, ease: "easeOut" } }}
        data-testid={`agent-card-${agent.id}`}
        className={cn(
          "border-b border-r-4 border-border px-2 py-2 transition-colors duration-300",
          containerClassName,
          borderForAgentState(effectiveState),
          isSelected && "bg-muted/60",
          isStopped && "opacity-60"
        )}
      >
        <AgentCardHeader
          agent={agent}
          childAgents={childAgents}
          isExpanded={isExpanded}
          isStopped={isStopped}
          isTerminalAgent={isTerminalAgent}
          connectedAgentId={connectedAgentId}
          closeOnSessionAction={closeOnSessionAction}
          onRequestClose={onRequestClose}
          detachTerminal={detachTerminal}
          attachToAgent={attachToAgent}
          startAgent={startAgent}
          toggleAgentDetails={toggleAgentDetails}
        />

        <AgentCardPhaseStatus agent={agent} />

        {isTerminalAgent ? null : (
          <AgentCardLatestEvent agent={agent} isExpanded={isExpanded} />
        )}

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
                  <AgentCardDetails
                    agent={agent}
                    diffStats={diffStats}
                    refreshDiffStats={refreshDiffStats}
                    fullAccessEnabled={fullAccessEnabled}
                    isTerminalAgent={isTerminalAgent}
                    enabledIdes={enabledIdes}
                    worktreePathCopied={worktreePathCopied}
                    copyWorktreePath={copyWorktreePath}
                  />
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
                {childAgents.length > 0 ? (
                  <div className="space-y-1.5 border-t border-border/50 pt-2">
                    <div className="flex items-center justify-between px-0.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">
                        Sub Agents
                      </span>
                      <span className="text-[10px] text-muted-foreground/55">
                        {childAgents.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {childAgents.map((child) => (
                        <ChildAgentRow
                          key={child.id}
                          agent={child}
                          state={getVisualState(child)}
                          isInitialReviewActive={
                            child.role === "review" &&
                            child.submittedReviewId == null
                          }
                          isConnected={connectedAgentId === child.id}
                          attachToAgent={attachToAgent}
                          detachTerminal={detachTerminal}
                          startAgent={startAgent}
                          openSubmittedReview={openSubmittedReview}
                          onRequestClose={onRequestClose}
                          closeOnSessionAction={closeOnSessionAction}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              {!agent.persona ? (
                <AgentCardActions
                  agent={agent}
                  isStopped={isStopped}
                  isTerminalAgent={isTerminalAgent}
                  enabledAgentTypes={enabledAgentTypes}
                  closeOnSessionAction={closeOnSessionAction}
                  onRequestClose={onRequestClose}
                  startAgent={startAgent}
                  onEditSettings={() => setSettingsOpen(true)}
                  setStopTarget={setStopTarget}
                  setStopConfirmOpen={setStopConfirmOpen}
                  setDeleteTarget={setDeleteTarget}
                  setDeleteConfirmOpen={setDeleteConfirmOpen}
                />
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      <SessionSettingsDialog
        agent={agent}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </React.Fragment>
  );
}
