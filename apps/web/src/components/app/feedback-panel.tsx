import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, CheckCircle2, ChevronRight, Copy, Expand, MessageCircleQuestion, RotateCcw, Wrench } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { type FeedbackItem } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
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

  if (feedback.length === 0) return null;

  const activeItems = feedback.filter((f) => f.status === "open" || f.status === "forwarded");
  const resolvedItems = feedback.filter((f) => f.status !== "open" && f.status !== "forwarded");
  const activeCount = activeItems.length;
  const visibleItems = showResolved ? feedback : activeItems;

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
        <div className="space-y-px">
          {visibleItems.map((item) => {
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
                  <span className="min-w-0 overflow-hidden font-mono text-muted-foreground">
                    <FrontTruncatedValue
                      value={item.filePath ? `${item.filePath.split("/").pop()}${item.lineNumber ? `:${item.lineNumber}` : ""}` : "—"}
                      mono
                    />
                  </span>
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
                      className="absolute -top-1.5 -right-1.5 p-1 rounded text-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                      onClick={() => setSheetItemId(item.id)}
                    >
                      <Expand className="h-3.5 w-3.5" />
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
        <SheetContent side="bottom" className="flex max-h-[80vh] flex-col overflow-hidden px-6 py-5">
          {sheetItem ? (
            <>
              <SheetHeader className="shrink-0">
                <div className="flex items-center gap-2">
                  <Badge variant={severityInfo(sheetItem.severity).variant}>
                    {severityInfo(sheetItem.severity).label}
                  </Badge>
                  <SheetTitle className="text-base">
                    {sheetItem.filePath
                      ? `${sheetItem.filePath}${sheetItem.lineNumber ? `:${sheetItem.lineNumber}` : ""}`
                      : "Feedback"}
                  </SheetTitle>
                </div>
                <SheetDescription className="text-xs text-muted-foreground">
                  From persona review
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Description</div>
                  <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{sheetItem.description}</div>
                </div>

                {sheetItem.suggestion ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">Suggestion</div>
                    <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">{sheetItem.suggestion}</div>
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
