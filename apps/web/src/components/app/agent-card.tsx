import React from "react";

import { AgentMeta } from "@/components/app/agent-meta";
import { AgentCardActions } from "@/components/app/agent-card-actions";
import { AgentCardDetails } from "@/components/app/agent-card-details";
import { AgentCardHeader } from "@/components/app/agent-card-header";
import { AgentCardActivity } from "@/components/app/agent-card-status";
import { AgentName } from "@/components/app/agent-name";
import { useAgentDiffStats } from "@/hooks/use-agent-diff-stats";
import { ChangeWorkspaceDialog } from "@/components/app/change-workspace-dialog";
import { SessionSettingsDialog } from "@/components/app/session-settings-dialog";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { SubAgentRows } from "@/components/app/sub-agent-rows";
import { AnimatePresence, motion } from "framer-motion";

import { descendantAgents } from "@/lib/agent-lineage";
import { lineageSeats } from "@/lib/agent-seat";
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

export type AgentCardContainerProps = {
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
  closeAgent: () => void;
  openAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
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
  isPinned?: boolean;
  onTogglePin?: (agentId: string) => void;
};

function AgentCardImpl({
  agent,
  agents,
  childAgents,
  selectedAgentId,
  expandedAgentId,
  agentVisualState: getVisualState,
  borderForAgentState,
  toggleAgentDetails,
  isFullAccessEnabled,
  closeAgent,
  openAgent,
  startAgent,
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
  isPinned = false,
  onTogglePin,
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
  // One details dialog for every sub agent row, tracking which row opened it.
  const [detailsChild, setDetailsChild] = React.useState<Agent | null>(null);
  // Likewise one Change workspace dialog: a collapsed row can unmount while
  // its dialog is open. The last target stays so the dialog can animate out.
  const [workspaceChild, setWorkspaceChild] = React.useState<{
    agent: Agent;
    open: boolean;
  } | null>(null);
  const cascadeCount = React.useMemo(
    () => descendantAgents(agent.id, agents).length,
    [agent.id, agents]
  );
  // Sub agents wear the seat the stream gives them; the card's own avatar
  // carries no number, since a flat list of roots would repeat seat 1.
  const seats = React.useMemo(
    () => (childAgents.length > 0 ? lineageSeats(agent.id, agents) : {}),
    [agent.id, agents, childAgents.length]
  );
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
          isSelected && "bg-surface-hover",
          isStopped && "opacity-60"
        )}
      >
        <AgentCardHeader
          agent={agent}
          childAgents={childAgents}
          isExpanded={isExpanded}
          isPinned={isPinned}
          isStopped={isStopped}
          connectedAgentId={connectedAgentId}
          closeOnSessionAction={closeOnSessionAction}
          onRequestClose={onRequestClose}
          closeAgent={closeAgent}
          openAgent={openAgent}
          startAgent={startAgent}
          toggleAgentDetails={toggleAgentDetails}
        />

        <AgentCardActivity
          agent={agent}
          // Expanded cards show sub agent activity in their own rows.
          childAgents={isExpanded ? undefined : childAgents}
          onNavigate={closeOnSessionAction ? onRequestClose : undefined}
        />

        <AnimatePresence initial={false}>
          {isExpanded ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mt-2 overflow-hidden"
            >
              <div className="flex flex-col gap-2 pb-0.5 pt-0.5">
                <AgentCardDetails
                  agent={agent}
                  personaParentName={
                    agent.parentAgentId
                      ? (agents.find((a) => a.id === agent.parentAgentId)
                          ?.name ?? <AgentName agentId={agent.parentAgentId} />)
                      : undefined
                  }
                  diffStats={diffStats}
                  refreshDiffStats={refreshDiffStats}
                  fullAccessEnabled={fullAccessEnabled}
                >
                  <SubAgentRows
                    childAgents={childAgents}
                    seats={seats}
                    viewingId={connectedAgentId}
                    actions={{
                      enabledAgentTypes,
                      enabledIdes,
                      cascadeCount: (child) =>
                        descendantAgents(child.id, agents).length,
                      onPause: (child) => {
                        setStopTarget(child);
                        setStopConfirmOpen(true);
                      },
                      onResume: (child) => void startAgent(child),
                      onArchive: (child) => {
                        setDeleteTarget(child);
                        setDeleteConfirmOpen(true);
                      },
                      onShowDetails: setDetailsChild,
                      onChangeWorkspace: (child) =>
                        setWorkspaceChild({ agent: child, open: true }),
                    }}
                    onOpenAgent={(child) => void openAgent(child)}
                    onNavigate={
                      closeOnSessionAction ? onRequestClose : undefined
                    }
                  />
                </AgentCardDetails>
                {agent.lastError && agent.status !== "running" ? (
                  <AgentMeta label="Last error" value={agent.lastError} />
                ) : null}
                <AgentCardActions
                  agent={agent}
                  isStopped={isStopped}
                  isPinned={isPinned}
                  onTogglePin={onTogglePin}
                  cascadeCount={cascadeCount}
                  enabledAgentTypes={enabledAgentTypes}
                  enabledIdes={enabledIdes}
                  onPause={() => {
                    setStopTarget(agent);
                    setStopConfirmOpen(true);
                  }}
                  onEditSettings={() => setSettingsOpen(true)}
                  onArchive={() => {
                    setDeleteTarget(agent);
                    setDeleteConfirmOpen(true);
                  }}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      <SessionSettingsDialog
        agent={agent}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <SessionSettingsDialog
        agent={detailsChild}
        open={detailsChild !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsChild(null);
        }}
        showDetails
      />
      {workspaceChild ? (
        <ChangeWorkspaceDialog
          agent={workspaceChild.agent}
          open={workspaceChild.open}
          onOpenChange={(open) =>
            setWorkspaceChild((current) =>
              current ? { ...current, open } : current
            )
          }
        />
      ) : null}
    </React.Fragment>
  );
}

/**
 * Memoised: a card re-renders when its own agent or props change, not every
 * time the page holding the sidebar does.
 */
export const AgentCard = React.memo(AgentCardImpl);
