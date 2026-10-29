import { ProjectSwitcher } from "./project-switcher";
import { ChevronDown } from "lucide-react";
import { useAtom } from "jotai";

import {
  AgentCard,
  type AgentCardContainerProps,
} from "@/components/app/agent-card";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { cachedAgentLineage } from "@/lib/agent-lineage";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  sortAgentTypes,
} from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import {
  agentSidebarOrderAtom,
  agentSidebarPinsAtom,
  reconcileAgentSidebarOrder,
} from "@/lib/store";
import {
  pinnedFirst,
  reorderSidebarPinGroup,
  toggleSidebarPin,
} from "@/lib/agent-sidebar-pins";
import { cn } from "@/lib/utils";

function dropPositionForEvent(event: DragEvent): "before" | "after" {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

/** Stable identity so a card with no sub agents does not re-render on every list change. */
const EMPTY_AGENTS: Agent[] = [];

export type AgentListContentProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  expandedAgentId: string | null;
  overflowAgentId: string | null;
  onOpenCreateDialog: (type?: AgentType) => void;
  enabledAgentTypes: AgentType[];
  enabledIdes: IdeType[];
  lastUsedAgentType: AgentType | null;
  setOverflowAgentId: (
    value: string | null | ((current: string | null) => string | null)
  ) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  agentVisualState: (agent: Agent) => AgentVisualState;
  borderForAgentState: (state: AgentVisualState) => string;
  toggleAgentDetails: (agentId: string) => void;
  isFullAccessEnabled: (
    agent: Pick<Agent, "agentArgs" | "fullAccess">
  ) => boolean;
  closeAgent: () => void;
  openAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
  connectedAgentId?: string | null;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
};

export function AgentListContent({
  agents,
  selectedAgentId,
  expandedAgentId,
  overflowAgentId: _overflowAgentId,
  onOpenCreateDialog,
  enabledAgentTypes,
  enabledIdes,
  lastUsedAgentType,
  setOverflowAgentId: _setOverflowAgentId,
  setDeleteTarget,
  setDeleteConfirmOpen,
  setStopTarget,
  setStopConfirmOpen,
  agentVisualState,
  borderForAgentState,
  toggleAgentDetails,
  isFullAccessEnabled,
  closeAgent,
  openAgent,
  startAgent,
  connectedAgentId,
  onRequestClose,
  closeOnSessionAction = false,
}: AgentListContentProps): JSX.Element {
  const [agentSidebarOrder, setAgentSidebarOrder] = useAtom(
    agentSidebarOrderAtom
  );
  const [sidebarPins, setSidebarPins] = useAtom(agentSidebarPinsAtom);
  const pinnedIds = useMemo(() => new Set(sidebarPins), [sidebarPins]);
  const togglePin = useCallback(
    (id: string) => {
      setSidebarPins((current) => toggleSidebarPin(current, id));
    },
    [setSidebarPins]
  );
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    agentId: string;
    position: "before" | "after";
  } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sortedAgentTypes = useMemo(
    () => sortAgentTypes(enabledAgentTypes),
    [enabledAgentTypes]
  );
  const defaultCreateType: AgentType =
    lastUsedAgentType && enabledAgentTypes.includes(lastUsedAgentType)
      ? lastUsedAgentType
      : (enabledAgentTypes[0] ?? "codex");
  const showCreateTypePicker = enabledAgentTypes.length > 1;
  const { topLevel: topLevelAgents, subAgentsByCardId } = useMemo(
    () => cachedAgentLineage(agents),
    [agents]
  );
  const topLevelAgentIds = useMemo(
    () => topLevelAgents.map((agent) => agent.id),
    [topLevelAgents]
  );
  const orderedTopLevelAgents = useMemo(() => {
    const reconciledOrder = reconcileAgentSidebarOrder(
      agentSidebarOrder,
      topLevelAgentIds
    );
    const agentById = new Map(topLevelAgents.map((agent) => [agent.id, agent]));
    return pinnedFirst(
      reconciledOrder
        .map((agentId) => agentById.get(agentId))
        .filter((agent): agent is Agent => Boolean(agent)),
      pinnedIds
    );
  }, [agentSidebarOrder, topLevelAgentIds, topLevelAgents, pinnedIds]);

  const moveAgent = useCallback(
    (
      draggedAgentId: string,
      targetAgentId: string,
      position: "before" | "after"
    ) => {
      if (
        draggedAgentId === targetAgentId ||
        pinnedIds.has(draggedAgentId) !== pinnedIds.has(targetAgentId)
      )
        return;
      setAgentSidebarOrder((currentOrder) => {
        const reconciledOrder = reconcileAgentSidebarOrder(currentOrder, [
          ...new Set([...topLevelAgentIds, ...currentOrder]),
        ]);
        return reorderSidebarPinGroup(
          reconciledOrder,
          topLevelAgentIds,
          pinnedIds,
          draggedAgentId,
          targetAgentId,
          position
        );
      });
    },
    [setAgentSidebarOrder, topLevelAgentIds, pinnedIds]
  );

  const moveAgentToBoundary = (
    draggedAgentId: string,
    position: "first" | "last"
  ) => {
    const group = orderedTopLevelAgents.filter(
      (agent) => pinnedIds.has(agent.id) === pinnedIds.has(draggedAgentId)
    );
    const target = position === "first" ? group[0] : group[group.length - 1];
    if (target)
      moveAgent(
        draggedAgentId,
        target.id,
        position === "first" ? "before" : "after"
      );
  };

  const moveAgentByOffset = useCallback(
    (agent: Agent, offset: -1 | 1) => {
      const group = orderedTopLevelAgents.filter(
        (card) => pinnedIds.has(card.id) === pinnedIds.has(agent.id)
      );
      const currentIndex = group.findIndex((card) => card.id === agent.id);
      const target = group[currentIndex + offset];
      if (!target) return;
      moveAgent(agent.id, target.id, offset < 0 ? "before" : "after");
      setReorderAnnouncement(
        `${agent.name} moved ${offset < 0 ? "up" : "down"} to position ${currentIndex + offset + 1} of ${group.length} in the ${pinnedIds.has(agent.id) ? "pinned" : "unpinned"} group.`
      );
    },
    [moveAgent, orderedTopLevelAgents, pinnedIds]
  );

  const clearDragState = useCallback(() => {
    setDraggingAgentId(null);
    setDropTarget(null);
  }, []);

  useEffect(() => {
    if (!draggingAgentId) return;
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState);
    return () => {
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState);
    };
  }, [clearDragState, draggingAgentId]);

  // One props object per card, rebuilt only when the list or a drag changes,
  // so a memoised card is not re-rendered by a fresh object every render.
  const containerPropsById = useMemo(
    () =>
      new Map(
        orderedTopLevelAgents.map(
          (agent): [string, AgentCardContainerProps] => [
            agent.id,
            {
              draggable: true,
              tabIndex: 0,
              "aria-describedby": "agent-sidebar-reorder-instructions",
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return;
                if (!event.altKey) return;
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveAgentByOffset(agent, -1);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveAgentByOffset(agent, 1);
                }
              },
              className: cn(
                "relative cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                draggingAgentId === agent.id && "opacity-55",
                dropTarget?.agentId === agent.id &&
                  dropTarget.position === "before" &&
                  draggingAgentId !== agent.id &&
                  "before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5 before:bg-primary",
                dropTarget?.agentId === agent.id &&
                  dropTarget.position === "after" &&
                  draggingAgentId !== agent.id &&
                  "after:absolute after:bottom-0 after:inset-x-0 after:z-10 after:h-0.5 after:bg-primary"
              ),
              nativeDragHandlers: {
                dragstart: (event) => {
                  const target = event.target as HTMLElement;
                  if (
                    target.closest(
                      "button,a,input,textarea,select,[data-agent-control='true']"
                    )
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (!event.dataTransfer) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", agent.id);
                  setDraggingAgentId(agent.id);
                },
                dragenter: (event) => {
                  event.preventDefault();
                  if (
                    !draggingAgentId ||
                    draggingAgentId === agent.id ||
                    pinnedIds.has(draggingAgentId) !== pinnedIds.has(agent.id)
                  ) {
                    setDropTarget(null);
                    return;
                  }
                  setDropTarget({
                    agentId: agent.id,
                    position: dropPositionForEvent(event),
                  });
                },
                dragover: (event) => {
                  if (
                    !draggingAgentId ||
                    draggingAgentId === agent.id ||
                    pinnedIds.has(draggingAgentId) !== pinnedIds.has(agent.id)
                  ) {
                    setDropTarget(null);
                    return;
                  }
                  event.preventDefault();
                  if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = "move";
                  }
                  setDropTarget({
                    agentId: agent.id,
                    position: dropPositionForEvent(event),
                  });
                },
                dragleave: (event) => {
                  if (
                    (event.currentTarget as HTMLElement).contains(
                      event.relatedTarget as Node | null
                    )
                  ) {
                    return;
                  }
                  setDropTarget((current) =>
                    current?.agentId === agent.id ? null : current
                  );
                },
                drop: (event) => {
                  event.preventDefault();
                  const draggedAgentId =
                    event.dataTransfer?.getData("text/plain") ||
                    draggingAgentId;
                  if (draggedAgentId) {
                    moveAgent(
                      draggedAgentId,
                      agent.id,
                      dropPositionForEvent(event)
                    );
                  }
                  clearDragState();
                },
              },
            },
          ]
        )
      ),
    [
      clearDragState,
      draggingAgentId,
      dropTarget,
      moveAgent,
      moveAgentByOffset,
      orderedTopLevelAgents,
      pinnedIds,
    ]
  );

  const handleBoundaryDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    position: "first" | "last"
  ) => {
    if (!draggingAgentId || orderedTopLevelAgents.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const group = orderedTopLevelAgents.filter(
      (agent) => pinnedIds.has(agent.id) === pinnedIds.has(draggingAgentId)
    );
    const boundaryAgent =
      position === "first" ? group[0] : group[group.length - 1];
    if (!boundaryAgent) return;
    setDropTarget({
      agentId: boundaryAgent.id,
      position: position === "first" ? "before" : "after",
    });
  };

  const handleBoundaryDrop = (
    event: React.DragEvent<HTMLDivElement>,
    position: "first" | "last"
  ) => {
    event.preventDefault();
    const draggedAgentId =
      event.dataTransfer.getData("text/plain") || draggingAgentId;
    if (draggedAgentId) {
      moveAgentToBoundary(draggedAgentId, position);
    }
    clearDragState();
  };

  return (
    <div data-testid="agent-sidebar" className="flex h-full min-h-0 flex-col">
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <div className="mr-2 min-w-0 flex-1">
          <ProjectSwitcher />
        </div>
        <div className="ml-auto flex items-center">
          <Button
            size="sm"
            variant="default"
            className={
              showCreateTypePicker
                ? "rounded-r-none border-r-0 text-muted-foreground hover:text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }
            onClick={() => onOpenCreateDialog(defaultCreateType)}
            data-testid="create-agent-button"
          >
            <AgentTypeIcon
              type={defaultCreateType}
              className="mr-1 h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
            />
            Create
          </Button>
          {showCreateTypePicker ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="default"
                  className="rounded-l-none border-l border-white/[0.12] px-1 text-muted-foreground hover:text-foreground"
                  data-testid="create-agent-type-dropdown"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {sortedAgentTypes.map((agentType) => (
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
          ) : null}
        </div>
      </div>

      <div
        data-testid="agent-sidebar-scroll"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <TooltipProvider delayDuration={120}>
          {agents.length === 0 ? (
            <div
              data-testid="no-agents-message"
              className="p-4 text-sm text-muted-foreground"
            >
              No agents yet.
            </div>
          ) : (
            <React.Fragment>
              <p id="agent-sidebar-reorder-instructions" className="sr-only">
                Focus an agent card and press Alt or Option plus Arrow Up or
                Arrow Down to reorder it within its pinned or unpinned group.
                Pinning a card also moves its nested sub agents.
              </p>
              <p className="sr-only" aria-live="polite">
                {reorderAnnouncement}
              </p>
              <div
                aria-hidden="true"
                className="h-3 shrink-0"
                onDragOver={(event) => handleBoundaryDragOver(event, "first")}
                onDrop={(event) => handleBoundaryDrop(event, "first")}
              />
              {orderedTopLevelAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  agents={agents}
                  childAgents={subAgentsByCardId.get(agent.id) ?? EMPTY_AGENTS}
                  selectedAgentId={selectedAgentId}
                  expandedAgentId={expandedAgentId}
                  agentVisualState={agentVisualState}
                  borderForAgentState={borderForAgentState}
                  toggleAgentDetails={toggleAgentDetails}
                  isFullAccessEnabled={isFullAccessEnabled}
                  closeAgent={closeAgent}
                  openAgent={openAgent}
                  startAgent={startAgent}
                  setDeleteTarget={setDeleteTarget}
                  setDeleteConfirmOpen={setDeleteConfirmOpen}
                  setStopTarget={setStopTarget}
                  setStopConfirmOpen={setStopConfirmOpen}
                  enabledAgentTypes={enabledAgentTypes}
                  enabledIdes={enabledIdes}
                  connectedAgentId={connectedAgentId}
                  onRequestClose={onRequestClose}
                  closeOnSessionAction={closeOnSessionAction}
                  isPinned={pinnedIds.has(agent.id)}
                  onTogglePin={togglePin}
                  containerProps={containerPropsById.get(agent.id)}
                />
              ))}
              <div
                aria-hidden="true"
                className="min-h-16 flex-1"
                onDragOver={(event) => handleBoundaryDragOver(event, "last")}
                onDrop={(event) => handleBoundaryDrop(event, "last")}
              />
            </React.Fragment>
          )}
        </TooltipProvider>
      </div>
    </div>
  );
}
