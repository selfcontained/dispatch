import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import { reviewVerdictLabel } from "@/components/app/agent-event-utils";
import { shortSha } from "@/components/app/feedback-utils";
import { useFeedbackData } from "@/components/app/use-feedback-data";
import {
  CancelRecheckButton,
  RoundChip,
} from "@/components/app/feedback-shared";
import {
  getVerdict,
  getReviewSummary,
  getFilesReviewed,
} from "@/components/app/persona-agent-review-utils";
import { type Agent } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";

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
