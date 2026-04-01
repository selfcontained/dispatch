import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Check, CheckCircle2, ChevronRight, Clipboard, Expand, Info, MessageCircleQuestion, RotateCcw, Wrench } from "lucide-react";

import { type Agent, type FeedbackItem } from "@/components/app/types";
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
  item,
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
  const btnClass = size === "sm" ? "h-5 gap-1 px-1.5 text-[10px]" : "h-7 gap-1.5 px-2.5 text-xs";
  const iconClass = size === "sm" ? "h-2.5 w-2.5" : "h-3.5 w-3.5";
  const resolveIconClass = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  const resolveBtnClass = size === "sm" ? "h-5 px-1 text-[10px]" : "h-7 px-2 text-xs gap-1.5";

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
              <Button variant="ghost" size="sm" className={btnClass + " text-muted-foreground"} onClick={onCopy}>
                {copied ? <Check className={iconClass + " text-green-500"} /> : <Clipboard className={iconClass} />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy to clipboard</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex items-center gap-px">
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
  personaAgent,
  sendTerminalInput,
  isConnected,
  onRequestClose,
  closeOnSessionAction,
}: {
  personaAgent: Agent;
  sendTerminalInput?: (data: string) => void;
  isConnected: boolean;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sheetItem, setSheetItem] = useState<FeedbackItem | null>(null);
  const [copied, copyText] = useCopyText();

  const { data: feedback = [] } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback", personaAgent.id],
    queryFn: async () => {
      const result = await api<{ feedback: FeedbackItem[] }>(`/api/v1/agents/${personaAgent.id}/feedback`);
      return result.feedback;
    },
  });

  if (feedback.length === 0) return null;

  const activeCount = feedback.filter((f) => f.status === "open" || f.status === "forwarded").length;

  const updateStatus = async (item: FeedbackItem, status: string) => {
    await api(`/api/v1/agents/${personaAgent.id}/feedback/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    const update = (f: FeedbackItem) => f.id === item.id ? { ...f, status: status as FeedbackItem["status"] } : f;
    queryClient.setQueryData<FeedbackItem[]>(["feedback", personaAgent.id], (old) => old?.map(update));
  };

  const dismissUI = () => {
    setSheetItem(null);
    if (closeOnSessionAction) onRequestClose?.();
  };

  const forward = (item: FeedbackItem, mode: "wdyt" | "fix") => {
    if (sendTerminalInput && isConnected) {
      const prefix = mode === "fix"
        ? `Fix the following issue found by the ${personaAgent.persona ?? "persona"} reviewer:`
        : `A ${personaAgent.persona ?? "persona"} reviewer flagged the following. What do you think — is this a real concern?`;
      const text = prefix + "\n" + formatFeedbackText(item) + "\r";
      sendTerminalInput(text);
      void updateStatus(item, "forwarded");
    }
    dismissUI();
  };

  const handleCopy = (item: FeedbackItem) => {
    copyText(formatFeedbackText(item));
    dismissUI();
  };

  const handleResolve = (item: FeedbackItem, status: string) => {
    void updateStatus(item, status);
    setSheetItem(null);
  };

  const severityInfo = (sev: string) => SEVERITY_LABELS[sev] ?? SEVERITY_LABELS.info;

  return (
    <>
      <div className="mt-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
          {personaAgent.persona ?? "Persona"} feedback ({activeCount} active)
        </div>
        {!isConnected && activeCount > 0 ? (
          <div className="text-[10px] text-muted-foreground/60 italic mb-1">
            Attach to this agent to forward feedback
          </div>
        ) : null}
        <div className="space-y-px">
          {feedback.map((item) => {
            const isActionable = item.status === "open" || item.status === "forwarded";
            const isExpanded = expandedId === item.id;
            const dotColor = SEVERITY_DOT[item.severity] ?? SEVERITY_DOT.info;
            const statusLabel = STATUS_LABELS[item.status];

            return (
              <div key={item.id} className={cn(!isActionable && "opacity-40")}>
                {/* Compact row */}
                <button
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted/40 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : item.id); }}
                >
                  <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform", isExpanded && "rotate-90")} />
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} />
                  <span className="min-w-0 truncate font-mono text-muted-foreground">
                    {item.filePath ? `${item.filePath.split("/").pop()}${item.lineNumber ? `:${item.lineNumber}` : ""}` : "—"}
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
                  <div className="ml-4 mr-1 mb-1.5 rounded-md border border-border bg-background px-2.5 py-2 text-xs shadow-sm" onClick={(e) => e.stopPropagation()}>
                    {item.filePath ? (
                      <div className="font-mono text-[10px] text-muted-foreground mb-1">
                        {item.filePath}{item.lineNumber ? `:${item.lineNumber}` : ""}
                      </div>
                    ) : null}
                    <div className="text-foreground leading-relaxed line-clamp-3">{item.description}</div>
                    {item.suggestion ? (
                      <div className="mt-1 text-muted-foreground leading-relaxed line-clamp-2">{item.suggestion}</div>
                    ) : null}

                    <div className="mt-2">
                      <FeedbackActions
                        item={item}
                        isConnected={isConnected}
                        onForward={(mode) => forward(item, mode)}
                        onCopy={() => handleCopy(item)}
                        copied={copied}
                        onUpdateStatus={(s) => handleResolve(item, s)}
                        isActionable={isActionable}
                        statusLabel={statusLabel}
                      />
                    </div>

                    <button
                      className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setSheetItem(item)}
                    >
                      <Expand className="h-2.5 w-2.5" /> View full
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Full feedback detail sheet */}
      <Sheet open={!!sheetItem} onOpenChange={(open) => { if (!open) setSheetItem(null); }}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          {sheetItem ? (
            <>
              <SheetHeader>
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
                  From {personaAgent.persona ?? "persona"} review
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 space-y-3">
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

                <div className="pt-2 border-t border-border">
                  <FeedbackActions
                    item={sheetItem}
                    isConnected={isConnected}
                    onForward={(mode) => forward(sheetItem, mode)}
                    onCopy={() => handleCopy(sheetItem)}
                    copied={copied}
                    onUpdateStatus={(s) => handleResolve(sheetItem, s)}
                    isActionable={sheetItem.status === "open" || sheetItem.status === "forwarded"}
                    statusLabel={STATUS_LABELS[sheetItem.status]}
                    size="default"
                  />
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
