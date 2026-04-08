import { Check, ChevronRight, Eye, ListChecks, Terminal, X, XCircle } from "lucide-react";

import { reviewVerdictLabel, type ReviewVerdict } from "@/components/app/agent-event-utils";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type PersonaAgentRowProps = {
  child: Agent;
  childIndex: number;
  childState: AgentVisualState;
  isSelected: boolean;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
  feedbackCount?: number;
  resolvedCount?: number;
  isCollapsed?: boolean;
  hasFeedback?: boolean;
  onTriage?: () => void;
  triageDisabled?: boolean;
  onOpenSummary?: () => void;
};

function PersonaStatusIcon({ reviewStatus, verdict, className }: { reviewStatus?: string | null; verdict?: ReviewVerdict; className?: string }): JSX.Element {
  // Review complete — show verdict icon
  if (reviewStatus === "complete" && verdict) {
    return <PersonaVerdictIcon verdict={verdict} className={className} />;
  }

  // Actively reviewing — pulsing eye
  if (reviewStatus === "reviewing") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full",
          "border border-status-working/50 bg-status-working/15 text-status-working",
          "animate-persona-reviewing",
          className
        )}
      >
        <Eye className="h-3 w-3" />
      </span>
    );
  }

  // No review record yet — default icon
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border",
        "border-border bg-muted/40 text-muted-foreground",
        className
      )}
    >
      <Eye className="h-3 w-3" />
    </span>
  );
}

function PersonaVerdictIcon({ verdict, className }: { verdict?: ReviewVerdict; className?: string }): JSX.Element {
  if (verdict === "approve") {
    return (
      <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-emerald-500/50 bg-emerald-500/15 text-emerald-500", className)}>
        <Check className="h-3 w-3" />
      </span>
    );
  }
  // request_changes or unknown
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-orange-500/50 bg-orange-500/15 text-orange-500", className)}>
      <XCircle className="h-3 w-3" />
    </span>
  );
}

export function getVerdict(child: Agent): ReviewVerdict | undefined {
  const v = child.review?.verdict;
  if (v === "approve" || v === "request_changes") return v;
  return undefined;
}

export function getReviewSummary(child: Agent): string | undefined {
  return child.review?.summary ?? undefined;
}

export function getFilesReviewed(child: Agent): string[] | undefined {
  const f = child.review?.filesReviewed;
  return Array.isArray(f) ? f : undefined;
}

export function PersonaAgentRow({
  child,
  childIndex,
  childState,
  isSelected,
  detachTerminal,
  attachToAgent,
  onRequestClose,
  closeOnSessionAction,
  feedbackCount,
  resolvedCount,
  isCollapsed,
  hasFeedback,
  onTriage,
  triageDisabled,
  onOpenSummary,
}: PersonaAgentRowProps): JSX.Element {
  const childIsStopped = childState === "stopped";
  const childIsActive = childState === "active";
  const colorVar = `var(--chart-${(childIndex % 4) + 1})`;
  const reviewStatus = child.review?.status ?? null;
  const isReviewing = reviewStatus === "reviewing";
  const verdict = getVerdict(child);
  const hasSummary = !!getReviewSummary(child);
  const reviewMessage = child.review?.message?.split("\n")[0] ?? null;

  return (
    <div
      data-testid={`agent-card-${child.id}`}
      className={cn(
        "flex items-center gap-2 border-r-2 px-2 py-1.5 transition-colors duration-200",
        hasFeedback && "cursor-pointer hover:bg-muted/50",
        childIsStopped && child.status !== "error" && "opacity-50",
        isSelected ? "border-r-status-done" : "border-r-transparent",
        isReviewing && "persona-reviewing-row"
      )}
    >
      {hasFeedback ? (
        <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform", !isCollapsed && "rotate-90")} />
      ) : null}
      <PersonaStatusIcon
        reviewStatus={reviewStatus}
        verdict={verdict}
        className="h-5 w-5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium" style={{ color: `hsl(${colorVar})` }}>
            {child.persona ?? child.name}
          </span>
          {feedbackCount != null && feedbackCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/20 px-1 text-[10px] font-semibold text-primary">{feedbackCount}</span>
          ) : resolvedCount != null && resolvedCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground/60">{resolvedCount}</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
          {verdict ? (
            hasSummary && onOpenSummary ? (
              <button
                data-agent-control="true"
                className={cn(
                  "font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid transition-colors",
                  verdict === "approve" ? "text-emerald-500 decoration-emerald-500/40 hover:decoration-emerald-500" : "text-orange-500 decoration-orange-500/40 hover:decoration-orange-500"
                )}
                onClick={(e) => { e.stopPropagation(); onOpenSummary(); }}
              >
                {reviewVerdictLabel(verdict)}
              </button>
            ) : (
              <span className={cn("font-medium", verdict === "approve" ? "text-emerald-500" : "text-orange-500")}>
                {reviewVerdictLabel(verdict)}
              </span>
            )
          ) : isReviewing ? (
            <span className="font-medium text-status-working">{reviewMessage ?? "Reviewing"}</span>
          ) : child.status === "running" ? (
            <span className="font-medium text-muted-foreground">Starting</span>
          ) : null}
        </div>
        {child.status === "error" ? (
          <div
            className="mt-0.5 truncate text-[10px] text-status-blocked/90"
            title={child.lastError ?? undefined}
          >
            {child.lastError?.split("\n")[0] ?? "Error"}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onTriage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span data-agent-control="true" className={cn(triageDisabled && "cursor-not-allowed")}>
                <button
                  aria-label="Auto-triage feedback"
                  disabled={triageDisabled}
                  className={cn("rounded p-2 transition-colors", triageDisabled ? "text-muted-foreground/25" : "text-muted-foreground/50 hover:text-foreground")}
                  onClick={onTriage}
                >
                  <ListChecks className="h-3.5 w-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{triageDisabled ? "Connect to parent agent to auto-triage" : "Auto-triage feedback"}</TooltipContent>
          </Tooltip>
        ) : null}
        {!childIsStopped ? (
          childIsActive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-agent-control="true"
                  aria-label="Disconnect from agent"
                  className="rounded p-2 text-muted-foreground/50 hover:text-foreground transition-colors"
                  onClick={() => detachTerminal()}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Disconnect</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-agent-control="true"
                  aria-label="Connect to agent terminal"
                  className="rounded p-2 text-muted-foreground/50 hover:text-foreground transition-colors"
                  onClick={() => {
                    if (closeOnSessionAction) onRequestClose?.();
                    void attachToAgent(child);
                  }}
                >
                  <Terminal className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>View terminal</TooltipContent>
            </Tooltip>
          )
        ) : null}
      </div>
    </div>
  );
}
