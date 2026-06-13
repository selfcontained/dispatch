import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { reviewVerdictLabel } from "@/components/app/agent-event-utils";
import {
  type FeedbackDetailState,
  bySeverity,
  formatFeedbackText,
  shortSha,
  SEVERITY_LABELS,
  STATUS_LABELS,
} from "@/components/app/feedback-utils";
import { useFeedbackData } from "@/components/app/use-feedback-data";
import {
  CancelRecheckButton,
  FeedbackActions,
  FeedbackItemNotFoundState,
  IgnoreReasonInput,
  ResolutionInfoBlock,
  RoundChip,
} from "@/components/app/feedback-shared";
import {
  getVerdict,
  getReviewSummary,
  getFilesReviewed,
} from "@/components/app/persona-agent-review-utils";
import { type Agent, type FeedbackItem } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useCopyText } from "@/hooks/use-copy";
import { Markdown } from "@/components/ui/markdown";

export { type FeedbackDetailState };

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
