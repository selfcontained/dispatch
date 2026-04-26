import {
  CircleDashed,
  Flag,
  ListChecks,
  Loader2,
  Terminal,
  ThumbsUp,
  X,
} from "lucide-react";

import {
  reviewVerdictLabel,
  type ReviewVerdict,
} from "@/components/app/agent-event-utils";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

type ReviewRoundBadge = {
  label: string;
  tone: "muted" | "pending" | "complete";
};

function getRoundBadge(child: Agent): ReviewRoundBadge | null {
  const review = child.review;
  if (!review) return null;
  if (review.status === "awaiting_recheck") {
    return { label: "R2 pending", tone: "pending" };
  }
  if (review.roundNumber >= 2) {
    return { label: "R2", tone: "complete" };
  }
  return { label: "R1", tone: "muted" };
}

function RoundBadge({ badge }: { badge: ReviewRoundBadge }): JSX.Element {
  const toneClass =
    badge.tone === "complete"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      : badge.tone === "pending"
        ? "border-status-reviewing/40 bg-status-reviewing/10 text-status-reviewing"
        : "border-border bg-muted/60 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded border px-1.5 text-[9px] font-semibold uppercase tracking-wider",
        toneClass
      )}
    >
      {badge.label}
    </span>
  );
}

function PersonaStatusIcon({
  reviewStatus,
  verdict,
  className,
}: {
  reviewStatus?: string | null;
  verdict?: ReviewVerdict;
  className?: string;
}): JSX.Element {
  if (reviewStatus === "complete" && verdict) {
    return <PersonaVerdictIcon verdict={verdict} className={className} />;
  }

  if (reviewStatus === "reviewing") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full",
          "border border-status-reviewing/50 bg-status-reviewing/15 text-status-reviewing",
          className
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border",
        "border-border bg-muted/40 text-muted-foreground",
        className
      )}
    >
      <CircleDashed className="h-3 w-3" />
    </span>
  );
}

function PersonaVerdictIcon({
  verdict,
  className,
}: {
  verdict?: ReviewVerdict;
  className?: string;
}): JSX.Element {
  if (verdict === "approve") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-emerald-500/50 bg-emerald-500/15 text-emerald-500",
          className
        )}
      >
        <ThumbsUp className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-orange-500/50 bg-orange-500/15 text-orange-500",
        className
      )}
    >
      <Flag className="h-3 w-3" />
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

export function getResolution(child: Agent) {
  return child.review?.resolution ?? undefined;
}

type StepColor = "orange" | "emerald" | "muted";

const STEP_COLOR: Record<StepColor, string> = {
  orange: "text-orange-500",
  emerald: "text-emerald-500",
  muted: "text-muted-foreground",
};

type StepDef = {
  label: string;
  color: StepColor;
  filled: boolean;
};

function StepRow({
  step,
  emphasis,
}: {
  step: StepDef;
  emphasis: "strong" | "soft";
}): JSX.Element {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        emphasis === "strong" ? "font-semibold" : "font-medium",
        STEP_COLOR[step.color]
      )}
    >
      {step.filled ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      ) : (
        <CircleDashed className="h-2.5 w-2.5 shrink-0" strokeWidth={2} />
      )}
      <span className="truncate">{step.label}</span>
    </span>
  );
}

/**
 * Stacked two-row button showing reviewer verdict and parent-response state.
 * Scales to multi-round cycles by letting each row grow independently.
 */
function ReviewStatusButton({
  step1,
  step2,
  onOpen,
}: {
  step1: StepDef;
  step2: StepDef;
  onOpen?: () => void;
}): JSX.Element {
  const ariaLabel = `${step1.label} — ${step2.label}`;

  const inner = (
    <>
      <StepRow step={step1} emphasis="strong" />
      <StepRow step={step2} emphasis="soft" />
    </>
  );

  if (onOpen) {
    return (
      <button
        data-agent-control="true"
        type="button"
        className="relative mt-1.5 flex w-full cursor-pointer flex-col items-stretch gap-0.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-left text-[10px] transition-colors hover:border-border/80 hover:bg-muted/70"
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className="relative mt-1.5 flex w-full flex-col items-stretch gap-0.5 text-[10px]"
      aria-label={ariaLabel}
    >
      {inner}
    </span>
  );
}

function stepsFromReview(
  child: Agent,
  verdict: ReviewVerdict
): { step1: StepDef; step2: StepDef } {
  const hasResolution = !!child.review?.resolution?.summary;
  const roundNumber = child.review?.roundNumber ?? 1;
  const allowRecheck = child.review?.allowRecheck ?? false;
  const reviewStatus = child.review?.status ?? null;
  const step1: StepDef = {
    label:
      roundNumber >= 2
        ? `${reviewVerdictLabel(verdict)} (R2)`
        : reviewVerdictLabel(verdict),
    color: verdict === "approve" ? "emerald" : "orange",
    filled: true,
  };
  let step2: StepDef;
  if (reviewStatus === "awaiting_recheck") {
    step2 = { label: "Rechecking", color: "orange", filled: false };
  } else if (allowRecheck && roundNumber < 2) {
    step2 = hasResolution
      ? { label: "Awaiting recheck", color: "muted", filled: false }
      : { label: "Awaiting resolution", color: "muted", filled: false };
  } else {
    step2 = hasResolution
      ? { label: "Responded", color: "muted", filled: true }
      : { label: "Awaiting response", color: "muted", filled: false };
  }
  return { step1, step2 };
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
  isCollapsed: _isCollapsed,
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
  const resolution = getResolution(child);
  const hasResolution = !!resolution?.summary;
  const reviewMessage = child.review?.message?.split("\n")[0] ?? null;
  const roundBadge = getRoundBadge(child);
  const isAwaitingRecheck = reviewStatus === "awaiting_recheck";

  return (
    <div
      data-testid={`agent-card-${child.id}`}
      className={cn(
        "relative flex items-start gap-2.5 px-2.5 py-2.5 transition-colors duration-200",
        hasFeedback && "cursor-pointer hover:bg-muted/50",
        isSelected && "bg-muted/35",
        (isSelected || isReviewing) && "rounded-lg",
        isReviewing && "persona-reviewing-row",
        childIsActive && "bg-muted/35"
      )}
    >
      <div className="flex shrink-0 items-center pt-0.5">
        <PersonaStatusIcon
          reviewStatus={reviewStatus}
          verdict={verdict}
          className="h-5 w-5"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            style={{ color: `hsl(${colorVar})` }}
          >
            {child.persona ?? child.name}
          </span>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:shrink-0">
            {childIsActive ? (
              <Badge
                variant="running"
                className="h-5 px-1.5 text-[9px]"
                data-testid={`review-agent-active-badge-${child.id}`}
              >
                <span className="sm:hidden">Active</span>
                <span className="hidden sm:inline">Active terminal</span>
              </Badge>
            ) : null}
            {roundBadge ? <RoundBadge badge={roundBadge} /> : null}
            {feedbackCount != null && feedbackCount > 0 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-status-waiting/45 bg-status-waiting/15 px-1.5 text-[10px] font-semibold text-status-waiting">
                {feedbackCount}
              </span>
            ) : null}
            {resolvedCount != null && resolvedCount > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground/60">
                {resolvedCount}
              </span>
            ) : null}
          </div>
        </div>
        {verdict ? (
          <ReviewStatusButton
            {...stepsFromReview(child, verdict)}
            onOpen={hasSummary || hasResolution ? onOpenSummary : undefined}
          />
        ) : isAwaitingRecheck ? (
          <div className="mt-1.5 text-[10px] font-medium text-status-reviewing">
            Rechecking
          </div>
        ) : isReviewing ? (
          <div className="mt-1.5 text-[10px] font-medium text-status-reviewing">
            {reviewMessage ?? "Reviewing"}
          </div>
        ) : child.status === "running" ? (
          <div className="mt-1.5 text-[10px] font-medium text-muted-foreground">
            Starting
          </div>
        ) : null}
        {child.status === "error" ? (
          <div
            className="mt-1.5 truncate text-[10px] text-status-blocked/90"
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
              <span
                data-agent-control="true"
                className={cn(triageDisabled && "cursor-not-allowed")}
              >
                <button
                  aria-label="Auto-triage feedback"
                  disabled={triageDisabled}
                  className={cn(
                    "rounded p-2 transition-colors",
                    triageDisabled
                      ? "text-muted-foreground/25"
                      : "text-muted-foreground/50 hover:text-foreground"
                  )}
                  onClick={onTriage}
                >
                  <ListChecks className="h-3.5 w-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {triageDisabled
                ? "Connect to parent agent to auto-triage"
                : "Auto-triage feedback"}
            </TooltipContent>
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
      {childIsActive ? (
        <span
          aria-hidden="true"
          data-testid={`review-agent-active-band-${child.id}`}
          className="absolute inset-y-0 right-0 w-1 rounded-r-lg bg-status-done"
        />
      ) : null}
    </div>
  );
}
