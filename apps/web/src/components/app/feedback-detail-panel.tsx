import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import {
  bySeverity,
  formatFeedbackText,
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
} from "@/components/app/feedback-shared";
import { type FeedbackItem } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCopyText } from "@/hooks/use-copy";
import { Markdown } from "@/components/ui/markdown";

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
