import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { reviewVerdictLabel } from "@/components/app/agent-event-utils";
import {
  getVerdict,
  getReviewSummary,
} from "@/components/app/persona-agent-review-utils";
import { PersonaAgentRow } from "@/components/app/persona-agent-row";
import {
  type FeedbackDetailState,
  bySeverity,
  compareFeedbackForPanel,
} from "@/components/app/feedback-utils";
import { FeedbackFindingRow } from "@/components/app/feedback-finding-row";
import {
  type Agent,
  type AgentVisualState,
  type FeedbackItem,
} from "@/components/app/types";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export { type FeedbackDetailState } from "@/components/app/feedback-utils";
export { FeedbackDetailPanel } from "@/components/app/feedback-detail-panel";
export { ReviewSummaryPanel } from "@/components/app/review-summary-panel";
export {
  MobileFeedbackSheet,
  MobileReviewSummarySheet,
} from "@/components/app/feedback-mobile";

export function ParentFeedbackPanel({
  parentAgentId,
  sendTerminalInput,
  isConnected,
  onRequestClose,
  closeOnSessionAction,
  onOpenDetail,
  activeDetailItemId,
  childAgents = [],
  selectedAgentId,
  agentVisualState: getVisualState,
  detachTerminal,
  attachToAgent,
}: {
  parentAgentId: string;
  sendTerminalInput?: (data: string) => void;
  isConnected: boolean;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
  onOpenDetail?: (state: FeedbackDetailState) => void;
  activeDetailItemId?: number | null;
  childAgents?: Agent[];
  selectedAgentId?: string | null;
  agentVisualState?: (agent: Agent) => AgentVisualState;
  detachTerminal?: () => void;
  attachToAgent?: (agent: Agent) => Promise<void>;
}): JSX.Element | null {
  const [showResolvedAgents, setShowResolvedAgents] = useState<Set<string>>(
    new Set()
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );

  const { data: feedback = [] } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback", parentAgentId, "children"],
    queryFn: async () => {
      const result = await api<{ feedback: FeedbackItem[] }>(
        `/api/v1/agents/${parentAgentId}/feedback?scope=children`
      );
      return result.feedback;
    },
    staleTime: 0,
  });

  const { data: allAgents = [] } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: async () => {
      const result = await api<{ agents: Agent[] }>("/api/v1/agents");
      return result.agents;
    },
    staleTime: 30_000,
  });
  const parentAgent = allAgents.find((a) => a.id === parentAgentId);

  const activeItems = useMemo(
    () =>
      feedback
        .filter((f) => f.status === "open" || f.status === "forwarded")
        .sort(bySeverity),
    [feedback]
  );
  const resolvedItems = useMemo(
    () =>
      feedback
        .filter((f) => f.status !== "open" && f.status !== "forwarded")
        .sort(bySeverity),
    [feedback]
  );

  if (feedback.length === 0 && childAgents.length === 0) return null;

  const activeFeedbackByAgent = new Map<string, FeedbackItem[]>();
  for (const item of activeItems) {
    const list = activeFeedbackByAgent.get(item.agentId);
    if (list) list.push(item);
    else activeFeedbackByAgent.set(item.agentId, [item]);
  }

  const resolvedFeedbackByAgent = new Map<string, FeedbackItem[]>();
  for (const item of resolvedItems) {
    const list = resolvedFeedbackByAgent.get(item.agentId);
    if (list) list.push(item);
    else resolvedFeedbackByAgent.set(item.agentId, [item]);
  }

  const agentIds = new Set(childAgents.map((a) => a.id));
  for (const agentId of activeFeedbackByAgent.keys()) {
    agentIds.add(agentId);
  }
  for (const agentId of resolvedFeedbackByAgent.keys()) {
    agentIds.add(agentId);
  }

  return (
    <>
      <div className="mt-1.5">
        <div className="mb-2 flex items-center justify-between px-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          <span>Persona reviews</span>
          <span>Verdicts and findings</span>
        </div>
        <div className="space-y-1.5">
          {childAgents.map((child, childIndex) => {
            const agentActive = activeFeedbackByAgent.get(child.id) ?? [];
            const agentResolved = resolvedFeedbackByAgent.get(child.id) ?? [];
            const showingResolved = showResolvedAgents.has(child.id);
            const round2Items = [...agentActive, ...agentResolved].filter(
              (item) => item.roundNumber >= 2
            );
            const linkedRound1Ids = new Set(
              round2Items
                .map((item) => item.respondsToFeedbackId)
                .filter((value): value is number => value != null)
            );
            const linkedRound1Items = [...agentActive, ...agentResolved].filter(
              (item) => item.roundNumber === 1 && linkedRound1Ids.has(item.id)
            );
            const items = (
              showingResolved
                ? [...agentActive, ...agentResolved]
                : [...agentActive, ...linkedRound1Items]
            ).filter(
              (item, index, all) =>
                all.findIndex((candidate) => candidate.id === item.id) === index
            );
            items.sort(compareFeedbackForPanel);
            const isGroupCollapsed = collapsedGroups.has(child.id);
            const childState = getVisualState?.(child);
            const unresolvedCount = agentActive.length;
            const resolvedCount = agentResolved.length;
            const hasAnyFeedback = unresolvedCount > 0 || resolvedCount > 0;

            const canTriage = isConnected && !!sendTerminalInput;
            const childVerdict = getVerdict(child);
            const childSummary = getReviewSummary(child);
            const handleTriage =
              unresolvedCount > 0
                ? () => {
                    if (!canTriage) return;
                    const personaName = child.persona ?? child.name;
                    const verdictContext = childVerdict
                      ? `\n\nThe reviewer's verdict was: ${reviewVerdictLabel(childVerdict)}.${childSummary ? ` Their summary: "${childSummary}"` : ""}`
                      : "";
                    const message = `Review and triage the pending feedback from the "${personaName}" persona.${verdictContext}\n\nUse the dispatch_get_feedback MCP tool to fetch the unresolved items, then address each one: fix the ones that should be fixed and resolve them as you go using dispatch_resolve_feedback. When done, provide a summary report explaining what you addressed and what you chose not to address along with why.`;
                    sendTerminalInput!(message + "\r");
                  }
                : undefined;

            const firstRound2Index = items.findIndex(
              (candidate) => candidate.roundNumber >= 2
            );

            return (
              <div
                key={child.id}
                data-testid={`review-agent-block-${child.id}`}
                className={cn(
                  "rounded-xl border border-border/60 border-r-4 border-r-transparent bg-background/25 px-1.5 py-1.5 transition-colors duration-200",
                  childState === "active" && "border-r-status-done bg-muted/20"
                )}
              >
                {getVisualState && detachTerminal && attachToAgent ? (
                  <div
                    className={cn(hasAnyFeedback && "cursor-pointer")}
                    onClick={(e) => {
                      if (
                        (e.target as HTMLElement).closest(
                          "[data-agent-control='true']"
                        )
                      )
                        return;
                      if (hasAnyFeedback) {
                        e.stopPropagation();
                        setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(child.id)) next.delete(child.id);
                          else next.add(child.id);
                          return next;
                        });
                      }
                    }}
                  >
                    <PersonaAgentRow
                      child={child}
                      childIndex={childIndex}
                      childState={childState!}
                      isSelected={selectedAgentId === child.id}
                      detachTerminal={detachTerminal}
                      attachToAgent={attachToAgent}
                      onRequestClose={onRequestClose}
                      closeOnSessionAction={closeOnSessionAction}
                      feedbackCount={unresolvedCount}
                      resolvedCount={resolvedCount}
                      isCollapsed={isGroupCollapsed}
                      hasFeedback={hasAnyFeedback}
                      onTriage={handleTriage}
                      triageDisabled={!canTriage}
                      onOpenSummary={() => {
                        if (
                          closeOnSessionAction &&
                          parentAgent &&
                          attachToAgent
                        ) {
                          if (selectedAgentId !== parentAgentId) {
                            void attachToAgent(parentAgent);
                          }
                          onRequestClose?.();
                        }
                        onOpenDetail?.({
                          parentAgentId,
                          summaryAgentId: child.id,
                        });
                      }}
                    />
                  </div>
                ) : null}
                <AnimatePresence initial={false}>
                  {!isGroupCollapsed && hasAnyFeedback
                    ? (() => {
                        return (
                          <motion.div
                            key={`feedback-${child.id}`}
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="overflow-hidden"
                          >
                            <div className="ml-8 mt-0.5 space-y-px">
                              <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                                Findings
                              </div>
                              {items.map((item, itemIndex) => (
                                <FeedbackFindingRow
                                  key={item.id}
                                  item={item}
                                  isSelected={item.id === activeDetailItemId}
                                  showRoundDivider={
                                    item.roundNumber >= 2 &&
                                    itemIndex === firstRound2Index
                                  }
                                  onClick={() => {
                                    if (item.id === activeDetailItemId) {
                                      onOpenDetail?.(null);
                                      return;
                                    }
                                    if (
                                      closeOnSessionAction &&
                                      parentAgent &&
                                      attachToAgent
                                    ) {
                                      if (selectedAgentId !== parentAgentId) {
                                        void attachToAgent(parentAgent);
                                      }
                                      onRequestClose?.();
                                    }
                                    onOpenDetail?.({
                                      parentAgentId,
                                      itemId: item.id,
                                    });
                                  }}
                                />
                              ))}
                              {resolvedCount > 0 ? (
                                <button
                                  className="mt-1 rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-muted-foreground"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowResolvedAgents((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(child.id))
                                        next.delete(child.id);
                                      else next.add(child.id);
                                      return next;
                                    });
                                  }}
                                >
                                  {showingResolved ? "Hide" : "Show"}{" "}
                                  {resolvedCount} resolved
                                </button>
                              ) : null}
                            </div>
                          </motion.div>
                        );
                      })()
                    : null}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
