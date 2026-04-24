import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  MessageCircleQuestion,
  RotateCcw,
  Wrench,
  X,
} from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { reviewVerdictLabel } from "@/components/app/agent-event-utils";
import {
  PersonaAgentRow,
  getVerdict,
  getReviewSummary,
  getFilesReviewed,
} from "@/components/app/persona-agent-row";
import {
  type Agent,
  type AgentVisualState,
  type FeedbackItem,
} from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
import { Markdown } from "@/components/ui/markdown";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type FeedbackDetailState =
  | { parentAgentId: string; itemId: number }
  | { parentAgentId: string; summaryAgentId: string }
  | null;

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
  info: "bg-muted-foreground",
};

const SEVERITY_LABELS: Record<
  string,
  { label: string; variant: "error" | "default" }
> = {
  critical: { label: "Critical", variant: "error" },
  high: { label: "High", variant: "error" },
  medium: { label: "Medium", variant: "default" },
  low: { label: "Low", variant: "default" },
  info: { label: "Info", variant: "default" },
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  forwarded: { label: "Sent", color: "text-blue-400" },
  fixed: { label: "Fixed", color: "text-green-500" },
  ignored: { label: "Ignored", color: "text-muted-foreground/60" },
};

function StatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}): JSX.Element | null {
  if (status === "fixed") {
    return <CheckCircle2 className={cn("h-3.5 w-3.5", className)} />;
  }
  if (status === "ignored") {
    return <Ban className={cn("h-3.5 w-3.5", className)} />;
  }
  return null;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function bySeverity(a: FeedbackItem, b: FeedbackItem): number {
  return (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4);
}

function compareFeedbackForPanel(a: FeedbackItem, b: FeedbackItem): number {
  if (a.roundNumber !== b.roundNumber) {
    return a.roundNumber - b.roundNumber;
  }
  const aThread = a.respondsToFeedbackId ?? a.id;
  const bThread = b.respondsToFeedbackId ?? b.id;
  if (aThread !== bThread) {
    return aThread - bThread;
  }
  return bySeverity(a, b);
}

function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}

function RoundChip({
  roundNumber,
  pending = false,
}: {
  roundNumber: number;
  pending?: boolean;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
        pending
          ? "border-status-reviewing/35 bg-status-reviewing/10 text-status-reviewing"
          : roundNumber >= 2
            ? "border-orange-500/30 bg-orange-500/10 text-orange-500"
            : "border-border bg-muted/50 text-muted-foreground"
      )}
    >
      {pending ? "R2 pending" : `R${roundNumber}`}
    </span>
  );
}

function canCancelRecheck(agent: Agent): boolean {
  const review = agent.review;
  if (!review?.allowRecheck) return false;
  return review.status === "awaiting_recheck";
}

function formatFeedbackText(item: FeedbackItem): string {
  const parts: string[] = [];
  if (item.filePath)
    parts.push(
      `File: ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    );
  parts.push(`Severity: ${item.severity}`);
  parts.push(item.description);
  if (item.suggestion) parts.push(`Suggestion: ${item.suggestion}`);
  return parts.join("\n");
}

function FeedbackItemNotFoundState({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <div
      data-testid="feedback-item-not-found"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center",
        className
      )}
    >
      <div className="max-w-sm space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Feedback item not found</p>
        <p>
          The URL points to a feedback item that is no longer available for this
          review agent.
        </p>
      </div>
    </div>
  );
}

function FeedbackActions({
  item: _item,
  isConnected,
  onForward,
  onCopy,
  copied,
  onUpdateStatus,
  isActionable,
  statusLabel,
  size = "sm",
}: {
  item: FeedbackItem;
  isConnected: boolean;
  onForward: (mode: "wdyt" | "fix") => void;
  onCopy: () => void;
  copied: boolean;
  onUpdateStatus: (status: string) => void;
  isActionable: boolean;
  statusLabel: { label: string; color: string } | undefined;
  size?: "sm" | "default";
}): JSX.Element {
  const btnClass =
    size === "sm"
      ? "h-6 gap-1 px-1.5 text-[10px]"
      : "h-7 gap-1.5 px-2.5 text-xs";
  const iconClass = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const resolveIconClass = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const resolveBtnClass =
    size === "sm" ? "h-6 px-1.5 text-[10px]" : "h-7 px-2 text-xs gap-1.5";

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        {isActionable ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(!isConnected && "cursor-not-allowed")}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      btnClass,
                      !isConnected && "opacity-40 pointer-events-none"
                    )}
                    onClick={() => onForward("wdyt")}
                  >
                    <MessageCircleQuestion className={iconClass} /> WDYT
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isConnected
                  ? "Ask what it thinks about this"
                  : "Connect to parent agent to forward feedback"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(!isConnected && "cursor-not-allowed")}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      btnClass,
                      !isConnected && "opacity-40 pointer-events-none"
                    )}
                    onClick={() => onForward("fix")}
                  >
                    <Wrench className={iconClass} /> Fix
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isConnected
                  ? "Tell agent to fix this"
                  : "Connect to parent agent to forward feedback"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={btnClass}
                onClick={onCopy}
              >
                {copied ? (
                  <Check className={iconClass + " text-green-500"} />
                ) : (
                  <Copy className={iconClass} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy to clipboard</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex items-center gap-1">
        {isActionable ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    resolveBtnClass + " text-green-500/70 hover:text-green-500"
                  }
                  onClick={() => onUpdateStatus("fixed")}
                >
                  <CheckCircle2 className={resolveIconClass} />
                  {size === "default" ? "Fixed" : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mark as fixed</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    resolveBtnClass +
                    " text-muted-foreground/50 hover:text-muted-foreground"
                  }
                  onClick={() => onUpdateStatus("ignored")}
                >
                  <Ban className={resolveIconClass} />
                  {size === "default" ? "Ignore" : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Ignore this finding</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <div className="flex items-center gap-1">
            {statusLabel ? (
              <span
                className={cn(
                  "text-[10px]",
                  size === "default" && "text-sm",
                  statusLabel.color
                )}
              >
                {statusLabel.label}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className={btnClass}
              onClick={() => onUpdateStatus("open")}
            >
              <RotateCcw className={iconClass} /> Reopen
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact feedback panel shown on the PARENT agent.
 */
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
  /** When provided, opens the detail in the main grid panel instead of a Sheet (desktop). */
  onOpenDetail?: (state: FeedbackDetailState) => void;
  /** The currently open detail item id (used to highlight the active row). */
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

  // Group active feedback by agentId
  const activeFeedbackByAgent = new Map<string, FeedbackItem[]>();
  for (const item of activeItems) {
    const list = activeFeedbackByAgent.get(item.agentId);
    if (list) list.push(item);
    else activeFeedbackByAgent.set(item.agentId, [item]);
  }

  // Group resolved feedback by agentId
  const resolvedFeedbackByAgent = new Map<string, FeedbackItem[]>();
  for (const item of resolvedItems) {
    const list = resolvedFeedbackByAgent.get(item.agentId);
    if (list) list.push(item);
    else resolvedFeedbackByAgent.set(item.agentId, [item]);
  }

  // Build ordered list: child agents first (preserving order), then any agentIds with feedback but no child agent
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
                className="rounded-xl border border-border/60 bg-background/25 px-1.5 py-1.5"
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

/* ------------------------------------------------------------------ */
/*  Shared hooks for feedback detail (used by both Sheet & inline)    */
/* ------------------------------------------------------------------ */

function useFeedbackData(parentAgentId: string) {
  const queryClient = useQueryClient();

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
  const parentCwd = parentAgent?.worktreePath ?? parentAgent?.cwd;

  type PersonaSummary = { slug: string; name: string };
  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", parentCwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(
        `/api/v1/personas?cwd=${encodeURIComponent(parentCwd ?? "")}`
      );
      return result.personas;
    },
    enabled: !!parentCwd,
  });

  const personaAttribution = useMemo(() => {
    const slugToIndex = new Map(personas.map((p, i) => [p.slug, i]));
    const map = new Map<string, { name: string; color: string }>();
    for (const agent of allAgents) {
      if (agent.parentAgentId === parentAgentId && agent.persona) {
        const idx = slugToIndex.get(agent.persona);
        const colorVar =
          idx != null ? `var(--chart-${(idx % 4) + 1})` : `var(--chart-1)`;
        const persona = personas.find((p) => p.slug === agent.persona);
        map.set(agent.id, {
          name: persona?.name ?? agent.persona,
          color: `hsl(${colorVar})`,
        });
      }
    }
    return map;
  }, [allAgents, parentAgentId, personas]);

  const updateStatus = useCallback(
    async (item: FeedbackItem, status: string, reason?: string) => {
      const body: { status: string; reason?: string } = { status };
      if (reason !== undefined) body.reason = reason;
      const response = await api<{ feedback: FeedbackItem }>(
        `/api/v1/agents/${item.agentId}/feedback/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      );
      queryClient.setQueryData<FeedbackItem[]>(
        ["feedback", parentAgentId, "children"],
        (old) => old?.map((f) => (f.id === item.id ? response.feedback : f))
      );
    },
    [queryClient, parentAgentId]
  );

  return { feedback, personaAttribution, updateStatus };
}

function ResolutionInfoBlock({
  item,
  className,
}: {
  item: FeedbackItem;
  className?: string;
}): JSX.Element | null {
  if (!item.resolutionReason && !item.resolutionCommit) return null;
  const sha = shortSha(item.resolutionCommit);
  return (
    <div className={cn("space-y-1", className)}>
      {item.resolutionReason ? (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
            Resolution reason
          </div>
          <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
            {item.resolutionReason}
          </div>
        </div>
      ) : null}
      {sha ? (
        <div className="text-[10px] text-muted-foreground/70">
          Resolved at commit{" "}
          <span className="font-mono text-muted-foreground">{sha}</span>
        </div>
      ) : null}
    </div>
  );
}

function CancelRecheckButton({
  parentAgentId,
  agent,
  onDone,
}: {
  parentAgentId: string;
  agent: Agent;
  onDone?: () => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();

  if (!canCancelRecheck(agent)) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground/80 hover:text-foreground"
      onClick={() => {
        const confirmed = window.confirm(
          "Cancel the recheck and let this reviewer exit?"
        );
        if (!confirmed) return;
        void api(
          `/api/v1/agents/${parentAgentId}/persona-reviews/${agent.id}/cancel-recheck`,
          { method: "POST" }
        ).then(async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["agents"] }),
            queryClient.invalidateQueries({
              queryKey: ["feedback", parentAgentId, "children"],
            }),
          ]);
          onDone?.();
        });
      }}
      data-testid="cancel-recheck-button"
    >
      Cancel recheck
    </Button>
  );
}

function IgnoreReasonInput({
  onCancel,
  onSubmit,
  size = "default",
}: {
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  size?: "sm" | "default";
}): JSX.Element {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;
  const submit = () => {
    if (canSubmit) onSubmit(trimmed);
  };
  const inputClass =
    size === "sm" ? "h-7 px-2 text-[11px]" : "h-11 px-3 text-sm";
  const btnClass = size === "sm" ? "h-7 px-2 text-[11px]" : "h-11 px-3 text-sm";
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border border-border bg-background/60 p-1"
      )}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // stopPropagation so the outer panel/sheet Esc handler doesn't
          // also fire and close the whole panel on cancel.
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Why ignore? (required)"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground/60 outline-none",
          inputClass
        )}
      />
      <Button
        variant="ghost"
        size="sm"
        className={btnClass + " text-muted-foreground/60 hover:text-foreground"}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        variant="default"
        size="sm"
        className={btnClass}
        disabled={!canSubmit}
        onClick={submit}
      >
        Ignore
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline feedback detail panel (rendered in the main grid)          */
/* ------------------------------------------------------------------ */

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

  // Auto-focus the panel when it opens
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
      // Advance within the same persona group
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
        // Show first resolved item instead of closing
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
        // Skip when the inline ignore input is open — it owns Esc to cancel.
        if (isIgnoring) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-white/[0.12] bg-[hsl(var(--card))] px-6 py-4 outline-none"
    >
      {/* Header row with nav + close */}
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

      {/* Scrollable content */}
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

      {/* Actions footer */}
      <div className="shrink-0 pt-2 border-t border-border mt-2">
        {ignoreTarget === item.id ? (
          <IgnoreReasonInput
            onCancel={() => setIgnoreTarget(null)}
            onSubmit={(reason) => handleResolve(item, "ignored", reason)}
          />
        ) : (
          <FeedbackActions
            item={item}
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

export function ReviewSummaryPanel({
  parentAgentId,
  agent,
  onClose,
}: {
  parentAgentId: string;
  agent: Agent;
  onClose: () => void;
}): JSX.Element | null {
  const { personaAttribution } = useFeedbackData(parentAgentId);

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, [agent.id]);

  const verdict = getVerdict(agent);
  const summary = getReviewSummary(agent);
  const filesReviewed = getFilesReviewed(agent);
  const resolution = agent.review?.resolution ?? null;
  const attr = personaAttribution.get(agent.id);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-white/[0.12] bg-[hsl(var(--card))] px-6 py-4 outline-none"
    >
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {verdict ? (
            <Badge variant={verdict === "approve" ? "default" : "error"}>
              {reviewVerdictLabel(verdict)}
            </Badge>
          ) : null}
          {agent.review ? (
            <RoundChip
              roundNumber={agent.review.roundNumber}
              pending={agent.review.status === "awaiting_recheck"}
            />
          ) : null}
          <span className="text-base font-semibold truncate">
            Review Summary
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
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 ml-4 opacity-70 hover:opacity-100"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {summary ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              Summary
            </div>
            <Markdown className="text-sm text-foreground">{summary}</Markdown>
          </div>
        ) : null}

        {filesReviewed && filesReviewed.length > 0 ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              Files Reviewed
            </div>
            <div className="space-y-0.5">
              {filesReviewed.map((f) => (
                <div
                  key={f}
                  className="font-mono text-xs text-muted-foreground"
                >
                  {f}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {resolution ? (
          <div className="rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              Parent's response
            </div>
            <Markdown className="text-sm text-foreground">
              {resolution.summary}
            </Markdown>
            {resolution.resolutionCommit ? (
              <div className="mt-2 text-[10px] text-muted-foreground/70">
                Submitted at commit{" "}
                <span className="font-mono text-muted-foreground">
                  {shortSha(resolution.resolutionCommit)}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {!summary && (!filesReviewed || filesReviewed.length === 0) ? (
          <div className="text-sm text-muted-foreground">
            No summary available.
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex justify-end border-t border-border pt-3">
        <CancelRecheckButton parentAgentId={parentAgentId} agent={agent} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Mobile bottom sheets (rendered at App level so they survive       */
/*  the sidebar closing)                                              */
/* ------------------------------------------------------------------ */

export function MobileFeedbackSheet({
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
      onClose();
    },
    [sendTerminalInput, isConnected, updateStatus, onClose]
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

  const severityInfoValue =
    item && (SEVERITY_LABELS[item.severity] ?? SEVERITY_LABELS.info);
  const attr = item ? personaAttribution.get(item.agentId) : undefined;
  const isActionable =
    item && (item.status === "open" || item.status === "forwarded");
  const isIgnoring = !!item && ignoreTarget === item.id;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        // Block the overlay/Esc close path from the Radix Sheet while the
        // inline reason input is open so the user doesn't lose their place.
        if (!open && !isIgnoring) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        hideCloseButton
        overlayClassName="z-[70]"
        className="z-[70] flex min-h-[40vh] max-h-[80vh] flex-col overflow-hidden px-6 py-5"
      >
        {item ? (
          <>
            <div className="absolute right-4 top-4 z-10 flex items-center space-x-8">
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {itemIndex + 1}/{navItems.length}
                  {!isActiveItem ? " resolved" : ""}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={!prevItem || isIgnoring}
                  onClick={() => prevItem && onNavigate(prevItem.id)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={!nextItem || isIgnoring}
                  onClick={() => nextItem && onNavigate(nextItem.id)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 opacity-70 hover:opacity-100"
                disabled={isIgnoring}
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <SheetHeader className="shrink-0">
              <div className="flex items-center gap-2 pr-40">
                <Badge
                  variant={severityInfoValue!.variant}
                  className="shrink-0"
                >
                  {severityInfoValue!.label}
                </Badge>
                {item ? <RoundChip roundNumber={item.roundNumber} /> : null}
                <SheetDescription className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                  {attr ? (
                    <>
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: attr.color }}
                      />
                      <span className="truncate" style={{ color: attr.color }}>
                        {attr.name}
                      </span>
                    </>
                  ) : (
                    <span className="truncate">From persona review</span>
                  )}
                </SheetDescription>
              </div>
              <SheetTitle className="break-all text-base">
                {item.filePath
                  ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
                  : "Feedback"}
              </SheetTitle>
            </SheetHeader>

            <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
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

            <div className="shrink-0 pt-2 border-t border-border">
              {ignoreTarget === item.id ? (
                <IgnoreReasonInput
                  onCancel={() => setIgnoreTarget(null)}
                  onSubmit={(reason) => handleResolve(item, "ignored", reason)}
                />
              ) : (
                <FeedbackActions
                  item={item}
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
                  isActionable={!!isActionable}
                  statusLabel={STATUS_LABELS[item.status]}
                  size="default"
                />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="absolute right-4 top-4 z-10">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 opacity-70 hover:opacity-100"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <SheetHeader className="shrink-0">
              <SheetTitle className="text-base">Feedback</SheetTitle>
              <SheetDescription>
                The requested feedback item could not be found.
              </SheetDescription>
            </SheetHeader>
            <FeedbackItemNotFoundState className="mt-4" />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function MobileReviewSummarySheet({
  parentAgentId,
  agent,
  onClose,
}: {
  parentAgentId: string;
  agent: Agent;
  onClose: () => void;
}): JSX.Element | null {
  const { personaAttribution } = useFeedbackData(parentAgentId);
  const verdict = getVerdict(agent);
  const summary = getReviewSummary(agent);
  const filesReviewed = getFilesReviewed(agent);
  const resolution = agent.review?.resolution ?? null;
  const attr = personaAttribution.get(agent.id);

  return (
    <Sheet
      open={!!agent}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        hideCloseButton
        overlayClassName="z-[70]"
        className="z-[70] flex min-h-[30vh] max-h-[70vh] flex-col overflow-hidden px-6 py-5"
      >
        <div className="absolute right-4 top-4 z-10">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 opacity-70 hover:opacity-100"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <SheetHeader className="shrink-0">
          <div className="flex items-center gap-2 pr-16">
            {verdict ? (
              <Badge
                className="shrink-0"
                variant={verdict === "approve" ? "default" : "error"}
              >
                {reviewVerdictLabel(verdict)}
              </Badge>
            ) : null}
            {agent.review ? (
              <RoundChip
                roundNumber={agent.review.roundNumber}
                pending={agent.review.status === "awaiting_recheck"}
              />
            ) : null}
            <SheetDescription className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              {attr ? (
                <>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: attr.color }}
                  />
                  <span className="truncate" style={{ color: attr.color }}>
                    {attr.name}
                  </span>
                </>
              ) : (
                <span className="truncate">{agent.persona ?? agent.name}</span>
              )}
            </SheetDescription>
          </div>
          <SheetTitle className="break-all text-base">
            Review Summary
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
          {summary ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
                Summary
              </div>
              <Markdown className="text-sm text-foreground">{summary}</Markdown>
            </div>
          ) : null}

          {filesReviewed && filesReviewed.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
                Files Reviewed
              </div>
              <div className="space-y-0.5">
                {filesReviewed.map((f) => (
                  <div
                    key={f}
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {f}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {resolution ? (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
                Parent's response
              </div>
              <Markdown className="text-sm text-foreground">
                {resolution.summary}
              </Markdown>
              {resolution.resolutionCommit ? (
                <div className="mt-2 text-[10px] text-muted-foreground/70">
                  Submitted at commit{" "}
                  <span className="font-mono text-muted-foreground">
                    {shortSha(resolution.resolutionCommit)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {!summary && (!filesReviewed || filesReviewed.length === 0) ? (
            <div className="text-sm text-muted-foreground">
              No summary available.
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex justify-end border-t border-border pt-3">
          <CancelRecheckButton
            parentAgentId={parentAgentId}
            agent={agent}
            onDone={onClose}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
