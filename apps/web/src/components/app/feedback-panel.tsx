import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, MessageCircleQuestion, RotateCcw, Wrench, X } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { reviewVerdictLabel } from "@/components/app/agent-event-utils";
import { PersonaAgentRow, getVerdict, getReviewSummary, getFilesReviewed } from "@/components/app/persona-agent-row";
import { type Agent, type AgentVisualState, type FeedbackItem } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

const SEVERITY_LABELS: Record<string, { label: string; variant: "error" | "default" }> = {
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

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

function bySeverity(a: FeedbackItem, b: FeedbackItem): number {
  return (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4);
}

function formatFeedbackText(item: FeedbackItem): string {
  const parts: string[] = [];
  if (item.filePath) parts.push(`File: ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`);
  parts.push(`Severity: ${item.severity}`);
  parts.push(item.description);
  if (item.suggestion) parts.push(`Suggestion: ${item.suggestion}`);
  return parts.join("\n");
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
  const btnClass = size === "sm" ? "h-6 gap-1 px-1.5 text-[10px]" : "h-7 gap-1.5 px-2.5 text-xs";
  const iconClass = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const resolveIconClass = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const resolveBtnClass = size === "sm" ? "h-6 px-1.5 text-[10px]" : "h-7 px-2 text-xs gap-1.5";

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        {isActionable ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(!isConnected && "cursor-not-allowed")}>
                  <Button
                    variant="ghost" size="sm"
                    className={cn(btnClass, !isConnected && "opacity-40 pointer-events-none")}
                    onClick={() => onForward("wdyt")}
                  >
                    <MessageCircleQuestion className={iconClass} /> WDYT
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{isConnected ? "Ask what it thinks about this" : "Connect to parent agent to forward feedback"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(!isConnected && "cursor-not-allowed")}>
                  <Button
                    variant="ghost" size="sm"
                    className={cn(btnClass, !isConnected && "opacity-40 pointer-events-none")}
                    onClick={() => onForward("fix")}
                  >
                    <Wrench className={iconClass} /> Fix
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{isConnected ? "Tell agent to fix this" : "Connect to parent agent to forward feedback"}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className={btnClass} onClick={onCopy}>
                {copied ? <Check className={iconClass + " text-green-500"} /> : <Copy className={iconClass} />}
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
                <Button variant="ghost" size="sm" className={resolveBtnClass + " text-green-500/70 hover:text-green-500"} onClick={() => onUpdateStatus("fixed")}>
                  <CheckCircle2 className={resolveIconClass} />
                  {size === "default" ? "Fixed" : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mark as fixed</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className={resolveBtnClass + " text-muted-foreground/50 hover:text-muted-foreground"} onClick={() => onUpdateStatus("ignored")}>
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
              <span className={cn("text-[10px]", size === "default" && "text-sm", statusLabel.color)}>{statusLabel.label}</span>
            ) : null}
            <Button variant="ghost" size="sm" className={btnClass} onClick={() => onUpdateStatus("open")}>
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
  const queryClient = useQueryClient();
  const [sheetItemId, setSheetItemId] = useState<number | null>(null);
  const [summaryAgentId, setSummaryAgentId] = useState<string | null>(null);
  const [copiedItemId, setCopiedItemId] = useState<number | null>(null);
  const [showResolvedAgents, setShowResolvedAgents] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [copied, copyText] = useCopyText();

  const { data: feedback = [] } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback", parentAgentId, "children"],
    queryFn: async () => {
      const result = await api<{ feedback: FeedbackItem[] }>(`/api/v1/agents/${parentAgentId}/feedback?scope=children`);
      return result.feedback;
    },
    staleTime: 0,
  });

  const sheetItem = sheetItemId != null ? feedback.find((f) => f.id === sheetItemId) ?? null : null;

  // Subscribe to agents cache reactively (query is managed by useAgents elsewhere)
  const { data: allAgents = [] } = useQuery<Agent[]>({ queryKey: ["agents"], enabled: false });
  const parentAgent = allAgents.find((a) => a.id === parentAgentId);
  const parentCwd = parentAgent?.worktreePath ?? parentAgent?.cwd;

  // Fetch personas directly so colors are always available, matching the
  // same query key used by PersonaLauncher for cache sharing.
  type PersonaSummary = { slug: string; name: string };
  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", parentCwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(`/api/v1/personas?cwd=${encodeURIComponent(parentCwd ?? "")}`);
      return result.personas;
    },
    enabled: !!parentCwd,
  });

  // Build agentId → persona attribution (name + color)
  const personaAttribution = useMemo(() => {
    const slugToIndex = new Map(personas.map((p, i) => [p.slug, i]));
    const map = new Map<string, { name: string; color: string }>();
    for (const agent of allAgents) {
      if (agent.parentAgentId === parentAgentId && agent.persona) {
        const idx = slugToIndex.get(agent.persona);
        const colorVar = idx != null ? `var(--chart-${(idx % 4) + 1})` : `var(--chart-1)`;
        const persona = personas.find((p) => p.slug === agent.persona);
        map.set(agent.id, { name: persona?.name ?? agent.persona, color: `hsl(${colorVar})` });
      }
    }
    return map;
  }, [allAgents, parentAgentId, personas]);

  const activeItems = useMemo(() => feedback.filter((f) => f.status === "open" || f.status === "forwarded").sort(bySeverity), [feedback]);
  const resolvedItems = useMemo(() => feedback.filter((f) => f.status !== "open" && f.status !== "forwarded").sort(bySeverity), [feedback]);
  const activeCount = activeItems.length;

  const sheetIsActive = sheetItem && (sheetItem.status === "open" || sheetItem.status === "forwarded");
  const sheetNavItems = sheetIsActive ? activeItems : resolvedItems;
  const sheetIndex = sheetItem ? sheetNavItems.findIndex((f) => f.id === sheetItem.id) : -1;
  const prevSheetItem = sheetIndex > 0 ? sheetNavItems[sheetIndex - 1]! : null;
  const nextSheetItem = sheetIndex >= 0 && sheetIndex < sheetNavItems.length - 1 ? sheetNavItems[sheetIndex + 1]! : null;

  const updateStatus = useCallback(async (item: FeedbackItem, status: string) => {
    await api(`/api/v1/agents/${item.agentId}/feedback/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    const update = (f: FeedbackItem) => f.id === item.id ? { ...f, status: status as FeedbackItem["status"] } : f;
    queryClient.setQueryData<FeedbackItem[]>(["feedback", parentAgentId, "children"], (old) => old?.map(update));
  }, [queryClient, parentAgentId]);

  const dismissUI = useCallback(() => {
    setSheetItemId(null);
    if (closeOnSessionAction) onRequestClose?.();
  }, [closeOnSessionAction, onRequestClose]);

  const forward = useCallback((item: FeedbackItem, mode: "wdyt" | "fix") => {
    if (sendTerminalInput && isConnected) {
      const prefix = mode === "fix"
        ? "Fix the following issue found by the persona reviewer:"
        : "A persona reviewer flagged the following. What do you think — is this a real concern?";
      const text = prefix + "\n" + formatFeedbackText(item) + "\r";
      sendTerminalInput(text);
      void updateStatus(item, "forwarded");
    }
    dismissUI();
  }, [sendTerminalInput, isConnected, updateStatus, dismissUI]);

  const handleCopy = useCallback((item: FeedbackItem) => {
    copyText(formatFeedbackText(item));
    setCopiedItemId(item.id);
  }, [copyText]);

  const handleResolve = useCallback((item: FeedbackItem, status: string) => {
    void updateStatus(item, status);
    // Auto-advance to the next unresolved item within the same persona
    const samePersona = activeItems.filter((f) => f.agentId === item.agentId);
    const idx = samePersona.findIndex((f) => f.id === item.id);
    const remaining = samePersona.filter((f) => f.id !== item.id);
    const nextId = remaining.length > 0
      ? remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]!.id
      : null;
    setSheetItemId(sheetItemId != null ? nextId : null);
  }, [updateStatus, activeItems, sheetItemId]);

  const severityInfo = (sev: string) => SEVERITY_LABELS[sev] ?? SEVERITY_LABELS.info;

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
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
          Reviewers{activeCount > 0 ? ` (${activeCount} findings)` : ""}
        </div>
        <div className="space-y-1.5">
          {childAgents.map((child, childIndex) => {
            const agentActive = activeFeedbackByAgent.get(child.id) ?? [];
            const agentResolved = resolvedFeedbackByAgent.get(child.id) ?? [];
            const showingResolved = showResolvedAgents.has(child.id);
            const items = showingResolved ? [...agentActive, ...agentResolved] : agentActive;
            const isGroupCollapsed = collapsedGroups.has(child.id);
            const childState = getVisualState?.(child);
            const unresolvedCount = agentActive.length;
            const resolvedCount = agentResolved.length;
            const hasAnyFeedback = unresolvedCount > 0 || resolvedCount > 0;

            const canTriage = isConnected && !!sendTerminalInput;
            const childVerdict = getVerdict(child);
            const childSummary = getReviewSummary(child);
            const handleTriage = unresolvedCount > 0
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
              <div key={child.id}>
                {getVisualState && detachTerminal && attachToAgent ? (
                  <div
                    className={cn(hasAnyFeedback && "cursor-pointer")}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("[data-agent-control='true']")) return;
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
                        if (onOpenDetail) {
                          onOpenDetail({ parentAgentId, summaryAgentId: child.id });
                        } else {
                          setSummaryAgentId(child.id);
                        }
                      }}
                    />
                  </div>
                ) : null}
                <AnimatePresence initial={false}>
                  {!isGroupCollapsed && hasAnyFeedback ? (() => {
                    return (
                      <motion.div
                        key={`feedback-${child.id}`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-px ml-4 mt-0.5">
                          {items.map((item) => {
                            const isActionable = item.status === "open" || item.status === "forwarded";
                            const dotColor = SEVERITY_DOT[item.severity] ?? SEVERITY_DOT.info;
                            const statusLabel = STATUS_LABELS[item.status];
                            const isSelected = item.id === (activeDetailItemId ?? sheetItemId);

                            return (
                              <div key={item.id} className={cn(!isActionable && "opacity-40")}>
                                <button
                                  className={cn(
                                    "flex w-full items-center gap-1.5 px-1 py-2 md:py-1 text-left text-[11px] transition-colors",
                                    "border-b-2",
                                    isSelected ? "border-primary" : "border-transparent hover:bg-muted/40"
                                  )}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isSelected) {
                                      if (onOpenDetail) onOpenDetail(null);
                                      else setSheetItemId(null);
                                    } else {
                                      if (onOpenDetail) onOpenDetail({ parentAgentId, itemId: item.id });
                                      else setSheetItemId(item.id);
                                    }
                                  }}
                                >
                                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} />
                                  <div className="min-w-0 overflow-hidden font-mono text-muted-foreground">
                                    <FrontTruncatedValue
                                      value={item.filePath ? `${item.filePath.split("/").pop()}${item.lineNumber ? `:${item.lineNumber}` : ""}` : "—"}
                                      mono
                                    />
                                  </div>
                                  <span className="min-w-0 flex-1 truncate text-foreground">
                                    {item.description}
                                  </span>
                                  {statusLabel && !isActionable ? (
                                    <span className={cn("shrink-0 text-[9px]", statusLabel.color)}>{statusLabel.label}</span>
                                  ) : null}
                                </button>
                              </div>
                            );
                          })}
                          {resolvedCount > 0 ? (
                            <button
                              className="mt-1 rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground/60 hover:bg-muted/40 hover:text-muted-foreground transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowResolvedAgents((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(child.id)) next.delete(child.id);
                                  else next.add(child.id);
                                  return next;
                                });
                              }}
                            >
                              {showingResolved ? "Hide" : "Show"} {resolvedCount} resolved
                            </button>
                          ) : null}
                        </div>
                      </motion.div>
                    );
                  })() : null}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      {/* Full feedback detail sheet — only used on mobile (when onOpenDetail is not provided) */}
      {!onOpenDetail ? <Sheet open={!!sheetItem} onOpenChange={(open) => { if (!open) setSheetItemId(null); }}>
        <SheetContent side="bottom" hideCloseButton overlayClassName="z-[70]" className="z-[70] flex min-h-[40vh] max-h-[80vh] flex-col overflow-hidden px-6 py-5">
          {sheetItem ? (
            <>
              {/* Nav + close in one container so they share alignment */}
              <div className="absolute right-4 top-4 flex items-center space-x-8 z-10">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {sheetIndex + 1}/{sheetNavItems.length}{!sheetIsActive ? " resolved" : ""}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    disabled={!prevSheetItem}
                    onClick={() => prevSheetItem && setSheetItemId(prevSheetItem.id)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    disabled={!nextSheetItem}
                    onClick={() => nextSheetItem && setSheetItemId(nextSheetItem.id)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 opacity-70 hover:opacity-100"
                  onClick={() => setSheetItemId(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <SheetHeader className="shrink-0">
                <div className="flex items-center gap-2 pr-32">
                  <Badge variant={severityInfo(sheetItem.severity).variant}>
                    {severityInfo(sheetItem.severity).label}
                  </Badge>
                  <SheetTitle className="text-base flex-1">
                    {sheetItem.filePath
                      ? `${sheetItem.filePath}${sheetItem.lineNumber ? `:${sheetItem.lineNumber}` : ""}`
                      : "Feedback"}
                  </SheetTitle>
                </div>
                <SheetDescription className="text-xs text-muted-foreground flex items-center gap-1.5">
                  {(() => {
                    const attr = personaAttribution.get(sheetItem.agentId);
                    if (attr) {
                      return (
                        <>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: attr.color }} />
                          <span style={{ color: attr.color }}>{attr.name}</span>
                        </>
                      );
                    }
                    return "From persona review";
                  })()}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Description</div>
                  <Markdown className="text-sm text-foreground">{sheetItem.description}</Markdown>
                </div>

                {sheetItem.suggestion ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Suggestion</div>
                    <Markdown className="text-sm text-muted-foreground">{sheetItem.suggestion}</Markdown>
                  </div>
                ) : null}
              </div>

              <div className="shrink-0 pt-2 border-t border-border">
                <FeedbackActions
                  item={sheetItem}
                  isConnected={isConnected}
                  onForward={(mode) => forward(sheetItem, mode)}
                  onCopy={() => handleCopy(sheetItem)}
                  copied={copied && copiedItemId === sheetItem.id}
                  onUpdateStatus={(s) => handleResolve(sheetItem, s)}
                  isActionable={sheetItem.status === "open" || sheetItem.status === "forwarded"}
                  statusLabel={STATUS_LABELS[sheetItem.status]}
                  size="default"
                />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet> : null}

      {/* Review summary sheet */}
      {(() => {
        const summaryAgent = summaryAgentId ? childAgents.find((a) => a.id === summaryAgentId) ?? null : null;
        const verdict = summaryAgent ? getVerdict(summaryAgent) : undefined;
        const summary = summaryAgent ? getReviewSummary(summaryAgent) : undefined;
        const filesReviewed = summaryAgent ? getFilesReviewed(summaryAgent) : undefined;
        const attr = summaryAgent ? personaAttribution.get(summaryAgent.id) : undefined;

        return (
          <Sheet open={!!summaryAgent} onOpenChange={(open) => { if (!open) setSummaryAgentId(null); }}>
            <SheetContent side="bottom" hideCloseButton overlayClassName="z-[70]" className="z-[70] flex min-h-[30vh] max-h-[70vh] flex-col overflow-hidden px-6 py-5">
              {summaryAgent ? (
                <>
                  <div className="absolute right-4 top-4 z-10">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 opacity-70 hover:opacity-100"
                      onClick={() => setSummaryAgentId(null)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <SheetHeader className="shrink-0">
                    <div className="flex items-center gap-2 pr-16">
                      {verdict ? (
                        <Badge variant={verdict === "approve" ? "default" : "error"}>
                          {reviewVerdictLabel(verdict)}
                        </Badge>
                      ) : null}
                      <SheetTitle className="text-base flex-1">Review Summary</SheetTitle>
                    </div>
                    <SheetDescription className="text-xs text-muted-foreground flex items-center gap-1.5">
                      {attr ? (
                        <>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: attr.color }} />
                          <span style={{ color: attr.color }}>{attr.name}</span>
                        </>
                      ) : (
                        <span>{summaryAgent.persona ?? summaryAgent.name}</span>
                      )}
                    </SheetDescription>
                  </SheetHeader>

                  <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
                    {summary ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Summary</div>
                        <Markdown className="text-sm text-foreground">{summary}</Markdown>
                      </div>
                    ) : null}

                    {filesReviewed && filesReviewed.length > 0 ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Files Reviewed</div>
                        <div className="space-y-0.5">
                          {filesReviewed.map((f) => (
                            <div key={f} className="font-mono text-xs text-muted-foreground">{f}</div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {!summary && (!filesReviewed || filesReviewed.length === 0) ? (
                      <div className="text-sm text-muted-foreground">No summary available.</div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </SheetContent>
          </Sheet>
        );
      })()}
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
      const result = await api<{ feedback: FeedbackItem[] }>(`/api/v1/agents/${parentAgentId}/feedback?scope=children`);
      return result.feedback;
    },
    staleTime: 0,
  });

  const { data: allAgents = [] } = useQuery<Agent[]>({ queryKey: ["agents"], enabled: false });
  const parentAgent = allAgents.find((a) => a.id === parentAgentId);
  const parentCwd = parentAgent?.worktreePath ?? parentAgent?.cwd;

  type PersonaSummary = { slug: string; name: string };
  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", parentCwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(`/api/v1/personas?cwd=${encodeURIComponent(parentCwd ?? "")}`);
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
        const colorVar = idx != null ? `var(--chart-${(idx % 4) + 1})` : `var(--chart-1)`;
        const persona = personas.find((p) => p.slug === agent.persona);
        map.set(agent.id, { name: persona?.name ?? agent.persona, color: `hsl(${colorVar})` });
      }
    }
    return map;
  }, [allAgents, parentAgentId, personas]);

  const updateStatus = useCallback(async (item: FeedbackItem, status: string) => {
    await api(`/api/v1/agents/${item.agentId}/feedback/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    const update = (f: FeedbackItem) => f.id === item.id ? { ...f, status: status as FeedbackItem["status"] } : f;
    queryClient.setQueryData<FeedbackItem[]>(["feedback", parentAgentId, "children"], (old) => old?.map(update));
  }, [queryClient, parentAgentId]);

  return { feedback, personaAttribution, updateStatus };
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
  const { feedback, personaAttribution, updateStatus } = useFeedbackData(parentAgentId);
  const [copied, copyText] = useCopyText();
  const [copiedItemId, setCopiedItemId] = useState<number | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const activeItems = useMemo(() => feedback.filter((f) => f.status === "open" || f.status === "forwarded").sort(bySeverity), [feedback]);
  const resolvedItems = useMemo(() => feedback.filter((f) => f.status !== "open" && f.status !== "forwarded").sort(bySeverity), [feedback]);
  const item = feedback.find((f) => f.id === itemId) ?? null;

  const isActiveItem = item && (item.status === "open" || item.status === "forwarded");
  const navItems = isActiveItem ? activeItems : resolvedItems;
  const itemIndex = item ? navItems.findIndex((f) => f.id === item.id) : -1;
  const prevItem = itemIndex > 0 ? navItems[itemIndex - 1]! : null;
  const nextItem = itemIndex >= 0 && itemIndex < navItems.length - 1 ? navItems[itemIndex + 1]! : null;

  // Auto-focus the panel when it opens
  useEffect(() => {
    panelRef.current?.focus();
  }, [itemId]);

  const forward = useCallback((feedbackItem: FeedbackItem, mode: "wdyt" | "fix") => {
    if (sendTerminalInput && isConnected) {
      const prefix = mode === "fix"
        ? "Fix the following issue found by the persona reviewer:"
        : "A persona reviewer flagged the following. What do you think — is this a real concern?";
      const text = prefix + "\n" + formatFeedbackText(feedbackItem) + "\r";
      sendTerminalInput(text);
      void updateStatus(feedbackItem, "forwarded");
    }
  }, [sendTerminalInput, isConnected, updateStatus]);

  const handleCopy = useCallback((feedbackItem: FeedbackItem) => {
    copyText(formatFeedbackText(feedbackItem));
    setCopiedItemId(feedbackItem.id);
  }, [copyText]);

  const handleResolve = useCallback((feedbackItem: FeedbackItem, status: string) => {
    void updateStatus(feedbackItem, status);
    // Advance within the same persona group
    const samePersona = activeItems.filter((f) => f.agentId === feedbackItem.agentId);
    const idx = samePersona.findIndex((f) => f.id === feedbackItem.id);
    const remaining = samePersona.filter((f) => f.id !== feedbackItem.id);
    if (remaining.length > 0) {
      onNavigate(remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]!.id);
    } else if (resolvedItems.length > 0) {
      // Show first resolved item instead of closing
      onNavigate(resolvedItems[0]!.id);
    } else {
      onClose();
    }
  }, [updateStatus, activeItems, resolvedItems, onNavigate, onClose]);

  if (!item) return null;

  const isActionable = item.status === "open" || item.status === "forwarded";
  const severityInfo = SEVERITY_LABELS[item.severity] ?? SEVERITY_LABELS.info;
  const attr = personaAttribution.get(item.agentId);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border bg-card px-6 py-4 outline-none"
    >
      {/* Header row with nav + close */}
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Badge variant={severityInfo!.variant}>
            {severityInfo!.label}
          </Badge>
          <span className="text-base font-semibold truncate">
            {item.filePath
              ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
              : "Feedback"}
          </span>
          {attr ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: attr.color }} />
              <span style={{ color: attr.color }}>{attr.name}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-4">
          <span className="text-xs text-muted-foreground tabular-nums">
            {itemIndex + 1}/{navItems.length}{!isActiveItem ? " resolved" : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!prevItem}
            onClick={() => prevItem && onNavigate(prevItem.id)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!nextItem}
            onClick={() => nextItem && onNavigate(nextItem.id)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 ml-4 opacity-70 hover:opacity-100"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Description</div>
          <Markdown className="text-sm text-foreground">{item.description}</Markdown>
        </div>

        {item.suggestion ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Suggestion</div>
            <Markdown className="text-sm text-muted-foreground">{item.suggestion}</Markdown>
          </div>
        ) : null}
      </div>

      {/* Actions footer */}
      <div className="shrink-0 pt-2 border-t border-border mt-2">
        <FeedbackActions
          item={item}
          isConnected={isConnected}
          onForward={(mode) => forward(item, mode)}
          onCopy={() => handleCopy(item)}
          copied={copied && copiedItemId === item.id}
          onUpdateStatus={(s) => handleResolve(item, s)}
          isActionable={isActionable}
          statusLabel={STATUS_LABELS[item.status]}
          size="default"
        />
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
  useEffect(() => { panelRef.current?.focus(); }, [agent.id]);

  const verdict = getVerdict(agent);
  const summary = getReviewSummary(agent);
  const filesReviewed = getFilesReviewed(agent);
  const attr = personaAttribution.get(agent.id);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border bg-card px-6 py-4 outline-none"
    >
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {verdict ? (
            <Badge variant={verdict === "approve" ? "default" : "error"}>
              {reviewVerdictLabel(verdict)}
            </Badge>
          ) : null}
          <span className="text-base font-semibold truncate">Review Summary</span>
          {attr ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: attr.color }} />
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
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Summary</div>
            <Markdown className="text-sm text-foreground">{summary}</Markdown>
          </div>
        ) : null}

        {filesReviewed && filesReviewed.length > 0 ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Files Reviewed</div>
            <div className="space-y-0.5">
              {filesReviewed.map((f) => (
                <div key={f} className="font-mono text-xs text-muted-foreground">{f}</div>
              ))}
            </div>
          </div>
        ) : null}

        {!summary && (!filesReviewed || filesReviewed.length === 0) ? (
          <div className="text-sm text-muted-foreground">No summary available.</div>
        ) : null}
      </div>
    </div>
  );
}
