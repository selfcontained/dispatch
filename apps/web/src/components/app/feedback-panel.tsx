import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { reviewVerdictLabel } from "@/components/app/agent-event-utils";
import {
  PersonaAgentRow,
  getVerdict,
  getReviewSummary,
} from "@/components/app/persona-agent-row";
import {
  type FeedbackDetailState,
  bySeverity,
  compareFeedbackForPanel,
  formatFeedbackText,
  SEVERITY_DOT,
  SEVERITY_LABELS,
  STATUS_LABELS,
} from "@/components/app/feedback-utils";
import { useFeedbackData } from "@/components/app/use-feedback-data";
import {
  FeedbackActions,
  FeedbackItemNotFoundState,
  IgnoreReasonInput,
  ResolutionInfoBlock,
  RoundChip,
  StatusIcon,
} from "@/components/app/feedback-shared";
import {
  type Agent,
  type AgentVisualState,
  type FeedbackItem,
} from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCopyText } from "@/hooks/use-copy";
import { Markdown } from "@/components/ui/markdown";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export { type FeedbackDetailState } from "@/components/app/feedback-utils";
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
                              {items.map((item) => {
                                const isActionable =
                                  item.status === "open" ||
                                  item.status === "forwarded";
                                const dotColor =
                                  SEVERITY_DOT[item.severity] ??
                                  SEVERITY_DOT.info;
                                const statusLabel = STATUS_LABELS[item.status];
                                const isSelected =
                                  item.id === activeDetailItemId;
                                const isRecheckItem =
                                  item.roundNumber >= 2 &&
                                  item.respondsToFeedbackId != null;
                                const showRoundDivider =
                                  item.roundNumber >= 2 &&
                                  items.findIndex(
                                    (candidate) => candidate.roundNumber >= 2
                                  ) === items.indexOf(item);

                                return (
                                  <div key={item.id}>
                                    {showRoundDivider ? (
                                      <div className="mb-1 mt-2 flex items-center gap-2 px-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                                        <span className="h-px flex-1 bg-border/70" />
                                        <span>Round 2 findings</span>
                                        <span className="h-px flex-1 bg-border/70" />
                                      </div>
                                    ) : null}
                                    <button
                                      className={cn(
                                        "flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left text-[11px] transition-colors",
                                        "border-b-2",
                                        isRecheckItem &&
                                          "ml-4 border-l border-border/60 pl-3",
                                        !isActionable && "opacity-40",
                                        isSelected
                                          ? "border-primary"
                                          : "border-transparent hover:bg-muted/40"
                                      )}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (isSelected) {
                                          onOpenDetail?.(null);
                                          return;
                                        }
                                        if (
                                          closeOnSessionAction &&
                                          parentAgent &&
                                          attachToAgent
                                        ) {
                                          if (
                                            selectedAgentId !== parentAgentId
                                          ) {
                                            void attachToAgent(parentAgent);
                                          }
                                          onRequestClose?.();
                                        }
                                        onOpenDetail?.({
                                          parentAgentId,
                                          itemId: item.id,
                                        });
                                      }}
                                    >
                                      <div className="flex w-full items-center gap-2">
                                        <RoundChip
                                          roundNumber={item.roundNumber}
                                        />
                                        <span
                                          className={cn(
                                            "h-1.5 w-1.5 shrink-0 rounded-full",
                                            dotColor
                                          )}
                                        />
                                        <div className="min-w-0 overflow-hidden font-mono text-muted-foreground">
                                          <FrontTruncatedValue
                                            value={
                                              item.filePath
                                                ? `${item.filePath.split("/").pop()}${item.lineNumber ? `:${item.lineNumber}` : ""}`
                                                : "—"
                                            }
                                            mono
                                          />
                                        </div>
                                        <span className="min-w-0 flex-1 truncate text-foreground">
                                          {item.description}
                                        </span>
                                        {statusLabel && !isActionable ? (
                                          <span
                                            className={cn(
                                              "shrink-0",
                                              statusLabel.color
                                            )}
                                            title={statusLabel.label}
                                          >
                                            <StatusIcon
                                              status={item.status}
                                              className={statusLabel.color}
                                            />
                                          </span>
                                        ) : null}
                                      </div>
                                      {isRecheckItem ? (
                                        <div className="ml-8 text-[10px] text-muted-foreground/70">
                                          Follow-up to round-1 finding #
                                          {item.respondsToFeedbackId}
                                        </div>
                                      ) : null}
                                      {!isActionable &&
                                      item.resolutionReason ? (
                                        <div
                                          className="ml-4 truncate pl-0.5 text-[10px] italic text-muted-foreground/70"
                                          title={item.resolutionReason}
                                        >
                                          {item.resolutionReason}
                                        </div>
                                      ) : null}
                                    </button>
                                  </div>
                                );
                              })}
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

export function FeedbackDetailPanel({
  parentAgentId,
  itemId,
  isConnected,
  sendTerminalInput,
  onClose,
  onNavigate,
}: {
  parentAgentId: string;
  itemId: number;
  isConnected: boolean;
  sendTerminalInput?: (data: string) => void;
  onClose: () => void;
  onNavigate: (itemId: number) => void;
}): JSX.Element | null {
  const { feedback, personaAttribution, updateStatus } =
    useFeedbackData(parentAgentId);
  const [copied, copyText] = useCopyText();
  const [copiedItemId, setCopiedItemId] = useState<number | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
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
  const item = feedback.find((f) => f.id === itemId) ?? null;

  const isActiveItem =
    item && (item.status === "open" || item.status === "forwarded");
  const navItems = isActiveItem ? activeItems : resolvedItems;
  const itemIndex = item ? navItems.findIndex((f) => f.id === item.id) : -1;
  const prevItem = itemIndex > 0 ? navItems[itemIndex - 1]! : null;
  const nextItem =
    itemIndex >= 0 && itemIndex < navItems.length - 1
      ? navItems[itemIndex + 1]!
      : null;

  useEffect(() => {
    panelRef.current?.focus();
  }, [itemId]);

  const forward = useCallback(
    (feedbackItem: FeedbackItem, mode: "wdyt" | "fix") => {
      if (sendTerminalInput && isConnected) {
        const prefix =
          mode === "fix"
            ? "Fix the following issue found by the persona reviewer:"
            : "A persona reviewer flagged the following. What do you think — is this a real concern?";
        const text = prefix + "\n" + formatFeedbackText(feedbackItem) + "\r";
        sendTerminalInput(text);
        void updateStatus(feedbackItem, "forwarded");
      }
    },
    [sendTerminalInput, isConnected, updateStatus]
  );

  const handleCopy = useCallback(
    (feedbackItem: FeedbackItem) => {
      copyText(formatFeedbackText(feedbackItem));
      setCopiedItemId(feedbackItem.id);
    },
    [copyText]
  );

  const [ignoreTarget, setIgnoreTarget] = useState<number | null>(null);

  const handleResolve = useCallback(
    (feedbackItem: FeedbackItem, status: string, reason?: string) => {
      void updateStatus(feedbackItem, status, reason);
      setIgnoreTarget(null);
      const samePersona = activeItems.filter(
        (f) => f.agentId === feedbackItem.agentId
      );
      const idx = samePersona.findIndex((f) => f.id === feedbackItem.id);
      const remaining = samePersona.filter((f) => f.id !== feedbackItem.id);
      if (remaining.length > 0) {
        onNavigate(
          remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]!.id
        );
      } else if (resolvedItems.length > 0) {
        onNavigate(resolvedItems[0]!.id);
      } else {
        onClose();
      }
    },
    [updateStatus, activeItems, resolvedItems, onNavigate, onClose]
  );

  if (!item) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-white/[0.12] bg-[hsl(var(--card))] px-6 py-4 outline-none">
        <FeedbackItemNotFoundState />
      </div>
    );
  }

  const isActionable = item.status === "open" || item.status === "forwarded";
  const severityInfo = SEVERITY_LABELS[item.severity] ?? SEVERITY_LABELS.info;
  const attr = personaAttribution.get(item.agentId);
  const isIgnoring = ignoreTarget === item.id;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (isIgnoring) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-white/[0.12] bg-[hsl(var(--card))] px-6 py-4 outline-none"
    >
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Badge variant={severityInfo!.variant}>{severityInfo!.label}</Badge>
          <RoundChip roundNumber={item.roundNumber} />
          <span className="text-base font-semibold truncate">
            {item.filePath
              ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
              : "Feedback"}
          </span>
          {attr ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: attr.color }}
              />
              <span style={{ color: attr.color }}>{attr.name}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-4">
          <span className="text-xs text-muted-foreground tabular-nums">
            {itemIndex + 1}/{navItems.length}
            {!isActiveItem ? " resolved" : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!prevItem || isIgnoring}
            onClick={() => prevItem && onNavigate(prevItem.id)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!nextItem || isIgnoring}
            onClick={() => nextItem && onNavigate(nextItem.id)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 ml-4 opacity-70 hover:opacity-100"
            disabled={isIgnoring}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
            Description
          </div>
          <Markdown className="text-sm text-foreground">
            {item.description}
          </Markdown>
        </div>

        {item.suggestion ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              Suggestion
            </div>
            <Markdown className="text-sm text-muted-foreground">
              {item.suggestion}
            </Markdown>
          </div>
        ) : null}

        {!isActionable ? <ResolutionInfoBlock item={item} /> : null}
      </div>

      <div className="shrink-0 pt-2 border-t border-border mt-2">
        {ignoreTarget === item.id ? (
          <IgnoreReasonInput
            onCancel={() => setIgnoreTarget(null)}
            onSubmit={(reason) => handleResolve(item, "ignored", reason)}
          />
        ) : (
          <FeedbackActions
            isConnected={isConnected}
            onForward={(mode) => forward(item, mode)}
            onCopy={() => handleCopy(item)}
            copied={copied && copiedItemId === item.id}
            onUpdateStatus={(s) => {
              if (s === "ignored") {
                setIgnoreTarget(item.id);
              } else {
                handleResolve(item, s);
              }
            }}
            isActionable={isActionable}
            statusLabel={STATUS_LABELS[item.status]}
            size="default"
          />
        )}
      </div>
    </div>
  );
}
