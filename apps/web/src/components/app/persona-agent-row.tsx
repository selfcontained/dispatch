import { Check, Eye, ListChecks, Terminal, X, XCircle } from "lucide-react";

import {
  reviewVerdictLabel,
  type ReviewVerdict,
} from "@/components/app/agent-event-utils";
import { type Agent, type AgentVisualState } from "@/components/app/types";
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

function PersonaStatusIcon({
  reviewStatus,
  verdict,
  className,
}: {
  reviewStatus?: string | null;
  verdict?: ReviewVerdict;
  className?: string;
}): JSX.Element {
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
        <Check className="h-3 w-3" />
      </span>
    );
  }
  // request_changes or unknown
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-orange-500/50 bg-orange-500/15 text-orange-500",
        className
      )}
    >
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

function StepperStep({ step }: { step: StepDef }): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap font-semibold",
        STEP_COLOR[step.color],
        !step.filled && "opacity-60"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          step.filled ? "bg-current" : "border border-current bg-transparent"
        )}
      />
      <span>{step.label}</span>
    </span>
  );
}

/**
 * Two-step pill showing reviewer verdict and parent-response state.
 * Pure presentation — caller derives step primitives from the source data.
 */
function ReviewStepper({
  step1,
  step2,
  connector,
  round,
  onOpen,
}: {
  step1: StepDef;
  step2: StepDef;
  connector: "solid" | "dashed";
  round?: number;
  onOpen?: () => void;
}): JSX.Element {
  const pillClass = cn(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 bg-background/40 px-2 py-0.5 text-[10px] transition-colors",
    onOpen && "cursor-pointer hover:bg-muted/40"
  );

  const inner = (
    <>
      <StepperStep step={step1} />
      <span
        aria-hidden
        className={cn(
          "h-0 w-3 shrink-0 border-t",
          connector === "solid"
            ? "border-border"
            : "border-dashed border-border/60"
        )}
      />
      <StepperStep step={step2} />
    </>
  );

  const badge =
    typeof round === "number" && round > 1 ? (
      <span className="inline-flex h-4 items-center rounded border border-border bg-muted/40 px-1 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        R{round}
      </span>
    ) : null;

  const ariaLabel = `${step1.label} — ${step2.label}`;

  return (
    <span className="inline-flex items-center gap-1">
      {badge}
      {onOpen ? (
        <button
          data-agent-control="true"
          className={pillClass}
          aria-label={ariaLabel}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {inner}
        </button>
      ) : (
        <span className={pillClass} aria-label={ariaLabel}>
          {inner}
        </span>
      )}
    </span>
  );
}

/** Derive stepper step primitives from Phase 1 review data. */
function stepsFromReview(
  verdict: ReviewVerdict,
  hasResolution: boolean
): { step1: StepDef; step2: StepDef; connector: "solid" | "dashed" } {
  const step1: StepDef = {
    label: reviewVerdictLabel(verdict),
    color: verdict === "approve" ? "emerald" : "orange",
    filled: true,
  };
  const step2: StepDef = hasResolution
    ? { label: "Responded", color: "muted", filled: true }
    : { label: "Awaiting response", color: "muted", filled: false };
  const connector: "solid" | "dashed" = hasResolution ? "solid" : "dashed";
  return { step1, step2, connector };
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

  return (
    <div
      data-testid={`agent-card-${child.id}`}
      className={cn(
        "flex items-start gap-2.5 px-2.5 py-2 transition-colors duration-200",
        hasFeedback && "cursor-pointer hover:bg-muted/50",
        childIsStopped && child.status !== "error" && "opacity-50",
        isSelected && "bg-muted/35",
        (isSelected || isReviewing) && "rounded-lg",
        isReviewing && "persona-reviewing-row"
      )}
    >
      <PersonaStatusIcon
        reviewStatus={reviewStatus}
        verdict={verdict}
        className="h-5 w-5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            style={{ color: `hsl(${colorVar})` }}
          >
            {child.persona ?? child.name}
          </span>
          <div className="flex shrink-0 items-center gap-1">
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
        <div className="mt-1 flex items-center gap-1 text-[10px]">
          {verdict ? (
            <ReviewStepper
              {...stepsFromReview(verdict, hasResolution)}
              onOpen={hasSummary || hasResolution ? onOpenSummary : undefined}
            />
          ) : isReviewing ? (
            <span className="font-medium text-status-working">
              {reviewMessage ?? "Reviewing"}
            </span>
          ) : child.status === "running" ? (
            <span className="font-medium text-muted-foreground">Starting</span>
          ) : null}
        </div>
        {child.status === "error" ? (
          <div
            className="mt-1 truncate text-[10px] text-status-blocked/90"
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
    </div>
  );
}
