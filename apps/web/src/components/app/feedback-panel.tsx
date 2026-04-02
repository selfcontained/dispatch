import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Maximize, MessageCircleQuestion, RotateCcw, Wrench, X } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { type Agent, type FeedbackItem } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

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
                <Button
                  variant="ghost" size="sm"
                  className={cn(btnClass, !isConnected && "opacity-40")}
                  disabled={!isConnected}
                  onClick={() => onForward("wdyt")}
                >
                  <MessageCircleQuestion className={iconClass} /> WDYT
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isConnected ? "Ask what it thinks about this" : "Attach to agent to use"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="sm"
                  className={cn(btnClass, !isConnected && "opacity-40")}
                  disabled={!isConnected}
                  onClick={() => onForward("fix")}
                >
                  <Wrench className={iconClass} /> Fix
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isConnected ? "Tell agent to fix this" : "Attach to agent to use"}</TooltipContent>
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
}: {
  parentAgentId: string;
  sendTerminalInput?: (data: string) => void;
  isConnected: boolean;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sheetItemId, setSheetItemId] = useState<number | null>(null);
  const [copiedItemId, setCopiedItemId] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [, copyText] = useCopyText();
  const copiedTimerRef = useRef<number | null>(null);

  const { data: feedback = [] } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback", parentAgentId, "children"],
    queryFn: async () => {
      const result = await api<{ feedback: FeedbackItem[] }>(`/api/v1/agents/${parentAgentId}/feedback?scope=children`);
      return result.feedback;
    },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAgents, parentAgentId, personas]);

  if (feedback.length === 0) return null;

  const activeItems = feedback.filter((f) => f.status === "open" || f.status === "forwarded");
  const resolvedItems = feedback.filter((f) => f.status !== "open" && f.status !== "forwarded");
  const activeCount = activeItems.length;
  const visibleItems = showResolved ? feedback : activeItems;

  const sheetIndex = sheetItem ? visibleItems.findIndex((f) => f.id === sheetItem.id) : -1;
  const prevSheetItem = sheetIndex > 0 ? visibleItems[sheetIndex - 1]! : null;
  const nextSheetItem = sheetIndex >= 0 && sheetIndex < visibleItems.length - 1 ? visibleItems[sheetIndex + 1]! : null;

  const updateStatus = async (item: FeedbackItem, status: string) => {
    await api(`/api/v1/agents/${item.agentId}/feedback/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    const update = (f: FeedbackItem) => f.id === item.id ? { ...f, status: status as FeedbackItem["status"] } : f;
    queryClient.setQueryData<FeedbackItem[]>(["feedback", parentAgentId, "children"], (old) => old?.map(update));
  };

  const dismissUI = () => {
    setSheetItemId(null);
    if (closeOnSessionAction) onRequestClose?.();
  };

  const forward = (item: FeedbackItem, mode: "wdyt" | "fix") => {
    if (sendTerminalInput && isConnected) {
      const prefix = mode === "fix"
        ? "Fix the following issue found by the persona reviewer:"
        : "A persona reviewer flagged the following. What do you think — is this a real concern?";
      const text = prefix + "\n" + formatFeedbackText(item) + "\r";
      sendTerminalInput(text);
      void updateStatus(item, "forwarded");
    }
    dismissUI();
  };

  const handleCopy = (item: FeedbackItem) => {
    copyText(formatFeedbackText(item));
    setCopiedItemId(item.id);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedItemId(null), 2000);
    dismissUI();
  };

  const handleResolve = (item: FeedbackItem, status: string) => {
    void updateStatus(item, status);
    // Auto-advance to the next unresolved item
    const remaining = activeItems.filter((f) => f.id !== item.id);
    const nextId = remaining.length > 0 ? remaining[0]!.id : null;
    setSheetItemId(sheetItemId != null ? nextId : null);
    setExpandedId(nextId);
  };

  const severityInfo = (sev: string) => SEVERITY_LABELS[sev] ?? SEVERITY_LABELS.info;

  return (
    <>
      <div className="mt-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
          Persona feedback ({activeCount} active)
        </div>
        {!isConnected && activeCount > 0 ? (
          <div className="text-[10px] text-muted-foreground/60 italic mb-1">
            Attach to this agent to forward feedback
          </div>
        ) : null}
        <div className="space-y-2">
          {(() => {
            // Group items by agentId to show persona sections
            const groups = new Map<string, FeedbackItem[]>();
            for (const item of visibleItems) {
              const list = groups.get(item.agentId);
              if (list) list.push(item);
              else groups.set(item.agentId, [item]);
            }
            const needsGrouping = groups.size > 1;

            return Array.from(groups.entries()).map(([agentId, items]) => {
              const attr = personaAttribution.get(agentId);
              const isGroupCollapsed = needsGrouping && collapsedGroups.has(agentId);
              return (
                <div key={agentId}>
                  {needsGrouping ? (
                    <button
                      className="flex w-full items-center gap-1.5 mb-0.5 text-left hover:bg-muted/40 rounded transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(agentId)) next.delete(agentId);
                          else next.add(agentId);
                          return next;
                        });
                      }}
                    >
                      <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform", !isGroupCollapsed && "rotate-90")} />
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: attr?.color ?? "hsl(var(--muted-foreground))" }}
                      />
                      <span
                        className="text-[10px] font-medium"
                        style={{ color: attr?.color ?? undefined }}
                      >
                        {attr?.name ?? agentId.slice(-6)}
                      </span>
                      <span className="text-[9px] text-muted-foreground/50">
                        {items.filter((f) => f.status === "open" || f.status === "forwarded").length}
                      </span>
                    </button>
                  ) : null}
                  {!isGroupCollapsed ? <div className={cn("space-y-px", needsGrouping && "ml-2.5")}>
                    {items.map((item) => {
                      const isActionable = item.status === "open" || item.status === "forwarded";
                      const isExpanded = expandedId === item.id;
                      const dotColor = SEVERITY_DOT[item.severity] ?? SEVERITY_DOT.info;
                      const statusLabel = STATUS_LABELS[item.status];

                      return (
                        <div key={item.id} className={cn(!isActionable && "opacity-40")}>
                          {/* Compact row */}
                          <button
                            className="flex w-full items-center gap-1.5 rounded px-1 py-2 md:py-1 text-left text-[11px] hover:bg-muted/40 transition-colors"
                            onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : item.id); }}
                          >
                            <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform", isExpanded && "rotate-90")} />
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

                          {/* Expanded inline card — clamped */}
                          {isExpanded ? (
                            <div className="relative ml-4 mr-1 mb-1.5 rounded-md border border-border bg-background px-2.5 py-2 text-xs shadow-sm" onClick={(e) => e.stopPropagation()}>
                              <button
                                className="absolute top-1 right-1 p-1 rounded text-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                                onClick={() => setSheetItemId(item.id)}
                              >
                                <Maximize className="h-3.5 w-3.5" />
                              </button>
                              <div className="text-foreground leading-relaxed line-clamp-3 pr-6">{item.description}</div>

                              <div className="mt-2">
                                <FeedbackActions
                                  item={item}
                                  isConnected={isConnected}
                                  onForward={(mode) => forward(item, mode)}
                                  onCopy={() => handleCopy(item)}
                                  copied={copiedItemId === item.id}
                                  onUpdateStatus={(s) => handleResolve(item, s)}
                                  isActionable={isActionable}
                                  statusLabel={statusLabel}
                                />
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div> : null}
                </div>
              );
            });
          })()}
        </div>
        {resolvedItems.length > 0 ? (
          <button
            className="mt-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            onClick={(e) => { e.stopPropagation(); setShowResolved(!showResolved); }}
          >
            {showResolved ? "Hide" : "Show"} {resolvedItems.length} resolved
          </button>
        ) : null}
      </div>

      {/* Full feedback detail sheet */}
      <Sheet open={!!sheetItem} onOpenChange={(open) => { if (!open) setSheetItemId(null); }}>
        <SheetContent side="bottom" hideCloseButton overlayClassName="z-[70]" className="z-[70] flex min-h-[40vh] max-h-[80vh] flex-col overflow-hidden px-6 py-5">
          {sheetItem ? (
            <>
              {/* Nav + close in one container so they share alignment */}
              <div className="absolute right-4 top-4 flex items-center space-x-8 z-10">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {sheetIndex + 1}/{visibleItems.length}
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
                  copied={copiedItemId === sheetItem.id}
                  onUpdateStatus={(s) => handleResolve(sheetItem, s)}
                  isActionable={sheetItem.status === "open" || sheetItem.status === "forwarded"}
                  statusLabel={STATUS_LABELS[sheetItem.status]}
                  size="default"
                />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
