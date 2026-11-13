import { MERGE_RISK } from "@/lib/merge-risk-presentation";
import { useId, useRef, useState } from "react";
import { AgentLinkControls, AgentMetadataLink } from "./agent-link-controls";
import { previewPullRequests } from "./agent-pull-requests.preview";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  RefreshCw,
  Sparkles,
  LoaderCircle,
  ExternalLink,
  Clock,
  CircleCheck,
  CircleX,
  Minus,
  CircleHelp,
  Clock3,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverArrow,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentPullRequest, MergeRiskSummary } from "@dispatch/shared";

type Status = AgentPullRequest["status"];
const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
const RISK_DISPLAY = {
  disabled: {
    label: "Risk assessment off",
    hint: "Set up AI merge risk in Settings.",
  },
  unavailable: {
    label: "Risk unavailable",
    hint: "Head or assessment unavailable. Waiting for refresh.",
  },
  waiting_ci: {
    label: "Risk · waiting for checks",
    hint: "Awaiting refresh from an earlier assessment policy.",
  },
  waiting_review: {
    label: "Risk · waiting for review",
    hint: "Waiting for resolved review findings.",
  },
  not_ready: {
    label: "Risk · not assessed",
    hint: "Requires a known head and resolved review findings. CI is assessed separately.",
  },
  evaluating: {
    label: "Risk · evaluating",
    hint: "Assessing this change.",
  },
  capacity: {
    label: "Risk · capacity limit",
    hint: "Two AI requests were already running. Retries on the next refresh.",
  },
  rate_limited: {
    label: "Risk · provider limit",
    hint: "Provider rate limit. No automatic retry.",
  },
  deferred: {
    label: "Risk · deferred",
    hint: "Assessment deferred. No recommendation.",
  },
  failure: {
    label: "Assessment failed",
    hint: "Provider failed. No recommendation.",
  },
};
function riskTone(risk: MergeRiskSummary) {
  if (
    risk.displayState === "failure" ||
    risk.displayState === "unavailable" ||
    (!risk.displayState && risk.status !== "ok") ||
    (!risk.displayState && risk.verdict === "human_review")
  )
    return "text-red-600 [[data-theme-mode=dark]_&]:text-red-400";
  if (risk.displayState === "evaluating") return "text-status-waiting";
  if (!risk.displayState && risk.verdict === "routine")
    return "text-status-working";
  return "text-muted-foreground";
}
function riskDisplay(risk: MergeRiskSummary) {
  if (risk.displayState)
    return {
      ...RISK_DISPLAY[risk.displayState],
      badge: MERGE_RISK.abstain.badge,
    };
  if (risk.status !== "ok")
    return { ...RISK_DISPLAY.failure, badge: MERGE_RISK.abstain.badge };
  return MERGE_RISK[risk.verdict];
}
/** Row-sized marker; the full badge and details live in the popover. */
function MergeRiskMarker({ risk }: { risk: MergeRiskSummary }) {
  const state = riskDisplay(risk);
  const Icon =
    !risk.displayState && risk.status === "ok" && risk.verdict === "routine"
      ? ShieldCheck
      : ShieldAlert;
  return (
    <span
      role="img"
      data-testid="merge-risk-marker"
      aria-label={`Merge risk: ${state.label}`}
      title={`Merge risk: ${state.label}`}
      className={cn(
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center",
        riskTone(risk)
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
    </span>
  );
}
function MergeRiskBadge({ risk }: { risk: MergeRiskSummary }) {
  const state = riskDisplay(risk);
  return (
    <Badge
      data-testid="merge-risk-badge"
      title={`Merge risk: ${state.label}`}
      className={cn(
        "shrink-0 px-1.5 py-0 text-[10px] normal-case tracking-normal",
        state.badge,
        riskTone(risk)
      )}
    >
      {state.label}
    </Badge>
  );
}
function EvidencePercent({
  value,
  meaning,
}: {
  value: number | null;
  meaning: "support" | "attention" | "context";
}) {
  const color =
    value === null
      ? undefined
      : meaning === "support"
        ? `color-mix(in srgb, var(--risk-positive) ${Math.round(value * 100)}%, var(--risk-negative))`
        : meaning === "attention"
          ? `color-mix(in srgb, var(--risk-attention) ${Math.round(value * 100)}%, var(--risk-neutral))`
          : "var(--risk-context)";
  return (
    <span
      className="tabular-nums font-medium text-muted-foreground [--risk-positive:#166534] [--risk-negative:#991b1b] [--risk-attention:#92400e] [--risk-neutral:#475569] [--risk-context:#1e40af] [[data-theme-mode=dark]_&]:[--risk-positive:#86efac] [[data-theme-mode=dark]_&]:[--risk-negative:#fca5a5] [[data-theme-mode=dark]_&]:[--risk-attention:#fcd34d] [[data-theme-mode=dark]_&]:[--risk-neutral:#cbd5e1] [[data-theme-mode=dark]_&]:[--risk-context:#93c5fd]"
      style={{ color }}
    >
      {percent(value)}
    </span>
  );
}
type ExplanationReply = {
  state: "ready" | "unavailable" | "pending" | "limited" | "failed";
  text?: string;
  reason?: string;
  limitedEvidence?: boolean;
};
const EXPLANATION_UNAVAILABLE: Record<
  string,
  { title: string; message: string }
> = {
  disabled: {
    title: "Explanations are off",
    message:
      "Turn on merge-risk assessments and save an API key in Settings → AI routing.",
  },
  not_found: {
    title: "Assessment not found",
    message:
      "This saved assessment is no longer available for this agent. It may have been removed from history.",
  },
  config_changed: {
    title: "Settings changed",
    message:
      "AI settings changed while preparing the explanation, so nothing was shown. Retry to use the new settings.",
  },
};
const EXPLANATION_FAILURES: Record<string, string> = {
  provider_rejected:
    "OpenAI rejected the request. Check the API key in Settings → AI routing.",
  provider_rate_limited: "OpenAI rate limit. Wait a minute, then retry.",
  provider_error: "OpenAI returned an error. You can retry.",
  timeout: "OpenAI did not answer in time. You can retry.",
  network: "Could not reach OpenAI. Check the connection, then retry.",
  malformed: "OpenAI returned an unusable answer. You can retry.",
  oversized: "Saved evidence is too large to explain. No request was made.",
};
/** One notice per outcome; "busy" never describes a failed request. */
function explanationNotice(data: ExplanationReply | undefined) {
  if (data?.state === "unavailable")
    return (
      EXPLANATION_UNAVAILABLE[data.reason ?? ""] ?? {
        title: "Explanation unavailable",
        message: "Could not explain this assessment.",
      }
    );
  if (data?.state === "limited")
    return {
      title: "Assessments busy",
      message: "Two AI requests are already running. Retry in a minute.",
    };
  if (data?.state === "pending")
    return {
      title: "Already in progress",
      message: "An explanation is already in progress. Check again shortly.",
    };
  return {
    title: "Explanation failed",
    message:
      (data?.reason && EXPLANATION_FAILURES[data.reason]) ??
      "Could not explain this assessment. You can retry.",
  };
}
function RiskExplanation({
  agentId,
  url,
  assessmentId,
  assessedHead,
}: {
  agentId: string;
  url: string;
  assessmentId: string;
  /** Set when the assessment is for an earlier commit than the PR's head. */
  assessedHead?: string;
}) {
  const [requested, setRequested] = useState(false);
  const query = useQuery<ExplanationReply>({
    queryKey: ["risk-explanation", agentId, url, assessmentId],
    enabled: false,
    retry: false,
    staleTime: Infinity,
    queryFn: () =>
      api(`/api/v1/agents/${agentId}/pull-requests/explain`, {
        method: "POST",
        body: JSON.stringify({ url, assessmentId }),
      }),
  });
  const ready =
    requested &&
    !query.isFetching &&
    !query.isError &&
    query.data?.state === "ready";
  const showNotice =
    requested && !query.isFetching && !ready && (query.isError || !!query.data);
  const failure = query.isError || query.data?.state === "failed";
  const notice = explanationNotice(query.isError ? undefined : query.data);
  const ActionIcon = query.isFetching
    ? LoaderCircle
    : requested
      ? RefreshCw
      : Sparkles;
  const NoticeIcon = failure
    ? CircleX
    : query.data?.state === "pending"
      ? Clock3
      : CircleHelp;
  const action = (
    <Button
      variant="default"
      size="sm"
      className="h-8 gap-1.5 border-border bg-muted/70 px-2.5 text-[11px] text-foreground shadow-sm backdrop-blur-none hover:border-border hover:bg-muted aria-disabled:cursor-wait aria-disabled:opacity-60"
      aria-disabled={query.isFetching}
      onClick={() => {
        if (query.isFetching) return;
        setRequested(true);
        void query.refetch();
      }}
    >
      <ActionIcon
        aria-hidden="true"
        className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")}
      />
      {query.isFetching
        ? "Explaining…"
        : requested && (query.isError || query.data)
          ? "Retry explanation"
          : "Explain assessment"}
    </Button>
  );
  return (
    <div className="space-y-2 text-[11px] text-muted-foreground">
      {!ready && (
        <Card
          role={showNotice ? (failure ? "alert" : "status") : undefined}
          className={cn(
            "rounded-lg shadow-none",
            showNotice
              ? cn(
                  "border p-2.5",
                  failure
                    ? "border-status-blocked/35 bg-status-blocked/5"
                    : "border-border bg-muted/30"
                )
              : "border-0 bg-transparent p-0 backdrop-blur-none"
          )}
        >
          <div className="flex items-start gap-2">
            {showNotice && (
              <NoticeIcon
                aria-hidden="true"
                className={cn(
                  "mt-0.5 h-3.5 w-3.5 shrink-0",
                  failure ? "text-status-blocked" : "text-muted-foreground"
                )}
              />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              {showNotice && (
                <div className="space-y-0.5">
                  <p
                    className={cn(
                      "font-medium",
                      failure ? "text-status-blocked" : "text-foreground"
                    )}
                  >
                    {notice.title}
                  </p>
                  <p className="leading-relaxed text-muted-foreground">
                    {notice.message}
                  </p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {action}
                {query.isFetching && (
                  <span role="status">Preparing explanation…</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}
      {!query.isFetching && ready && (
        <>
          <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
            {query.data?.text?.split(/(`[^`\n]+`)/g).map((part, index) =>
              index % 2 === 1 ? (
                <code
                  key={index}
                  className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] [overflow-wrap:anywhere]"
                >
                  {part.slice(1, -1)}
                </code>
              ) : (
                part
              )
            )}
          </p>
          {query.data?.limitedEvidence && (
            <p className="leading-relaxed">
              Supporting detail for this assessment wasn't saved, so this uses
              only its recorded scores.
            </p>
          )}
          <p className="text-[10px] leading-relaxed">
            {assessedHead && (
              <>
                Explains the assessment of{" "}
                <span className="font-mono">{assessedHead.slice(0, 7)}</span>,
                not the current code ·{" "}
              </>
            )}
            Evidence-based follow-up · not private scoring reasoning or merge
            approval.
          </p>
        </>
      )}
    </div>
  );
}

function MergeRiskDetails({
  risk,
  ci,
  agentId,
  url,
}: {
  agentId?: string;
  url: string;
  risk: MergeRiskSummary;
  ci: AgentPullRequest["ci"];
}) {
  const checks = ciPresentation(ci);
  const ChecksIcon = checks.icon;
  const state = riskDisplay(risk);
  const assessment = risk.displayState ? risk.previous : risk;
  // Any saved assessment can be explained as it was made, current or not.
  const explanation = agentId &&
    assessment?.status === "ok" &&
    assessment.assessmentId && (
      <RiskExplanation
        key={assessment.assessmentId}
        agentId={agentId}
        url={url}
        assessmentId={assessment.assessmentId}
        assessedHead={
          risk.displayState || assessment.headSha !== ci?.headSha
            ? assessment.headSha
            : undefined
        }
      />
    );
  return (
    <section className="space-y-3 border-t border-border p-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold">Merge risk</h4>
          <div className="flex items-center gap-2">
            <MergeRiskBadge risk={risk} />
            <span
              tabIndex={0}
              aria-label={`Current CI: ${checks.label}`}
              title={`Current CI: ${checks.label}. Risk is independent of checks; required checks must pass before merge.`}
              className={cn(
                "inline-flex items-center gap-1 text-[10px]",
                checks.color
              )}
            >
              <ChecksIcon aria-hidden="true" className="h-3 w-3" />
              <span>CI</span>
            </span>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">{state.hint}</p>
      </div>
      {!risk.displayState && explanation}
      {assessment && (
        <div className="space-y-3">
          {risk.displayState && (
            <>
              <hr className="border-border" />
              <div className="flex items-center justify-between gap-3">
                <h5 className="text-xs font-medium text-foreground">
                  Previous assessment
                </h5>
                <MergeRiskBadge risk={assessment} />
              </div>
              {explanation}
            </>
          )}
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2 text-[11px]">
            <dt className="text-muted-foreground">Change risk</dt>
            <dd
              className={cn(
                "text-right font-medium",
                assessment.changeRiskLabel === "high" ||
                  assessment.changeRiskLabel === "critical"
                  ? "text-red-600 [[data-theme-mode=dark]_&]:text-red-400"
                  : assessment.changeRiskLabel === "low"
                    ? "text-status-working"
                    : "text-status-waiting"
              )}
            >
              {assessment.changeRiskLabel ?? "—"}
            </dd>
            <dt
              className="text-muted-foreground"
              title="Higher means stronger review engagement."
            >
              Review engaged
            </dt>
            <dd className="text-right">
              <EvidencePercent
                value={assessment.reviewAdequate}
                meaning="support"
              />
            </dd>
            <dt
              className="text-muted-foreground"
              title="Higher means the description better matches the change."
            >
              Description matches
            </dt>
            <dd className="text-right">
              <EvidencePercent
                value={assessment.descriptionMatches}
                meaning="support"
              />
            </dd>
            <dt
              className="text-muted-foreground"
              title="Likelihood of a new product surface; context, not a quality score."
            >
              New surface
            </dt>
            <dd className="text-right">
              <EvidencePercent
                value={assessment.newSurface}
                meaning="context"
              />
            </dd>
            <dt
              className="text-muted-foreground"
              title="Higher means a person is more likely to need to review this change."
            >
              Needs human review
            </dt>
            <dd className="text-right">
              <EvidencePercent
                value={assessment.humanReviewProbability}
                meaning="attention"
              />
            </dd>
            <dt
              className="text-muted-foreground"
              title="Model certainty; not merge readiness."
            >
              Model confidence
            </dt>
            <dd className="text-right">
              <EvidencePercent
                value={assessment.confidence}
                meaning="context"
              />
            </dd>
          </dl>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span className="font-mono">{assessment.headSha.slice(0, 7)}</span>
            <span>·</span>
            <time dateTime={assessment.assessedAt}>
              {new Date(assessment.assessedAt).toLocaleString([], {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </time>
            <span>· Not merge approval.</span>
          </div>
        </div>
      )}
    </section>
  );
}

const STATES = {
  Open: {
    icon: GitPullRequest,
    color: "text-status-working",
    badge: "border-status-working/20 bg-status-working/10 text-status-working",
    label: "Open",
  },
  Draft: {
    icon: GitPullRequestDraft,
    color: "text-muted-foreground",
    badge: "border-border bg-muted/50 text-muted-foreground",
    label: "Draft",
  },
  Merged: {
    icon: GitMerge,
    color: "text-status-merged",
    badge: "border-status-merged/20 bg-status-merged/10 text-status-merged",
    label: "Merged",
  },
  Closed: {
    icon: GitPullRequestClosed,
    color: "text-status-blocked",
    badge: "border-status-blocked/20 bg-status-blocked/10 text-status-blocked",
    label: "Closed",
  },
  Pending: {
    icon: Clock3,
    color: "text-muted-foreground",
    badge: "border-border bg-muted/50 text-muted-foreground",
    label: "Checking",
  },
  Unavailable: {
    icon: CircleHelp,
    color: "text-status-waiting",
    badge: "border-status-waiting/20 bg-status-waiting/10 text-status-waiting",
    label: "Unavailable",
  },
} satisfies Record<
  Status,
  { icon: typeof GitPullRequest; color: string; badge: string; label: string }
>;
function identity(url: string) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return {
    number: /^\d+$/.test(parts.at(-1) ?? "") ? `#${parts.at(-1)}` : "PR",
    repo: parts.slice(0, 2).join("/"),
  };
}
function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge
      className={cn(
        "shrink-0 px-1.5 py-0 text-[10px] normal-case tracking-normal",
        STATES[status].badge
      )}
    >
      {STATES[status].label}
    </Badge>
  );
}

type CiSnapshot = NonNullable<AgentPullRequest["ci"]>;
export type PresentedPullRequest = AgentPullRequest;

function ciPresentation(ci: CiSnapshot | undefined) {
  if (!ci || ci.availability === "unavailable")
    return {
      label: "Checks unavailable",
      icon: CircleHelp,
      color: "text-muted-foreground",
    };
  const { summary } = ci;
  if (summary.failed)
    return {
      label: `${summary.failed} failed${summary.pending ? ` · ${summary.pending} pending` : ""}`,
      icon: CircleX,
      color: "text-status-blocked",
    };
  if (summary.pending)
    return {
      label: `${summary.pending} pending`,
      icon: Clock3,
      color: "text-status-waiting",
    };
  if (summary.status === "none")
    return { label: "No checks", icon: Minus, color: "text-muted-foreground" };
  return {
    label: `${summary.passed}/${summary.total} passed`,
    icon: CircleCheck,
    color: "text-status-working",
  };
}

function checkResult(check: CiSnapshot["checks"][number]) {
  if (!check.conclusion)
    return {
      label: check.status === "IN_PROGRESS" ? "Running" : "Pending",
      icon: Clock3,
      color: "text-status-waiting",
    };
  if (check.conclusion === "SUCCESS")
    return {
      label: "Passed",
      icon: CircleCheck,
      color: "text-status-working",
    };
  if (check.conclusion === "SKIPPED" || check.conclusion === "NEUTRAL")
    return {
      label: check.conclusion === "SKIPPED" ? "Skipped" : "Neutral",
      icon: Minus,
      color: "text-muted-foreground",
    };
  return {
    label:
      check.conclusion === "FAILURE"
        ? "Failed"
        : check.conclusion.toLowerCase().replaceAll("_", " "),
    icon: CircleX,
    color: "text-status-blocked",
  };
}

export function checkDuration(
  check: CiSnapshot["checks"][number],
  checkedAt: string
): string | null {
  if (!check.startedAt) return null;
  const end =
    check.completedAt ??
    (check.status === "IN_PROGRESS" ? checkedAt : undefined);
  if (!end) return null;
  const observed = Date.parse(checkedAt);
  const started = Date.parse(check.startedAt);
  const finished = Date.parse(end);
  const elapsed = finished - started;
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    started > observed ||
    finished > observed
  )
    return null;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function CompactChecks({ ci }: { ci?: CiSnapshot }) {
  const state = ciPresentation(ci);
  const Icon =
    ci?.availability === "available" && !ci.summary.failed && ci.summary.pending
      ? Clock
      : state.icon;
  const label =
    ci?.availability === "available" && ci.summary.total
      ? [
          [ci.summary.passed, "passed"],
          [ci.summary.failed, "failed"],
          [ci.summary.pending, "pending"],
          [ci.summary.skipped, "skipped"],
        ]
          .filter(([count]) => Number(count) > 0)
          .map(([count, name]) => `${count} ${name}`)
          .join(", ")
      : state.label;
  return (
    <span
      role="img"
      aria-label={ci?.summary.total ? `Checks: ${label}` : label}
      title={label}
      className={cn(
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center",
        state.color
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
    </span>
  );
}

/** Server snapshots + SSE own freshness; each PR has its own stable metadata row. */
export function AgentPullRequests({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName?: string;
}) {
  const client = useQueryClient();
  const [hidden, setHidden] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const hasDismissError = failed.some((key) => key.startsWith(`${agentId}:`));
  const dismiss = useMutation({
    mutationFn: (url: string) =>
      api(`/api/v1/agents/${agentId}/pull-requests/dismiss`, {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    onMutate: (url) => {
      setHidden((values) => [...values, `${agentId}:${url}`]);
      setFailed((values) =>
        values.filter((value) => value !== `${agentId}:${url}`)
      );
    },
    onError: (_error, url) => {
      setFailed((values) => [...values, `${agentId}:${url}`]);
      setHidden((values) =>
        values.filter((value) => value !== `${agentId}:${url}`)
      );
    },
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["agent-pull-requests", agentId],
      });
    },
  });
  const preview =
    import.meta.env.DEV &&
    agentId === "seed-agent-running-main" &&
    new URLSearchParams(window.location.search).get("pr-preview") === "1";
  const { data, isError } = useQuery({
    queryKey: ["agent-pull-requests", agentId],
    enabled: !preview,
    queryFn: ({ signal }) =>
      api<{ pullRequests: PresentedPullRequest[] }>(
        `/api/v1/agents/${agentId}/pull-requests`,
        { signal }
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const prs = preview ? previewPullRequests : (data?.pullRequests ?? []);
  if (!prs.length && !hasDismissError)
    return isError ? (
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <CircleHelp className="h-3.5 w-3.5 shrink-0" />
        <span>PR status unavailable</span>
      </div>
    ) : null;
  return (
    <div data-testid={`agent-pr-row-${agentId}`} className="contents">
      {hasDismissError && (
        <p role="alert" className="text-xs text-destructive">
          Could not dismiss PR. Please try again.
        </p>
      )}
      {prs
        .filter((pr) => !hidden.includes(`${agentId}:${pr.url}`))
        .map((pr) => (
          <RefreshablePullRequestRow
            key={pr.url}
            pr={pr}
            agentId={agentId}
            onDismiss={() => dismiss.mutate(pr.url)}
            agentName={agentName}
            isError={isError}
          />
        ))}
    </div>
  );
}

export function PullRequestRow({
  onDismiss,
  refresh,
  agentId,
  pr,
  isError,
}: {
  onDismiss: () => void;
  refresh?: ReturnType<typeof usePullRequestRefresh>;
  pr: PresentedPullRequest;
  agentName?: string;
  agentId?: string;
  isError: boolean;
}) {
  const risk =
    pr.mergeRisk?.displayState === "disabled" ? undefined : pr.mergeRisk;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeFocusRef = useRef<HTMLButtonElement | null>(null);
  const contentId = useId();
  const openOnPointerDown = useRef(false);
  const dismissedOutside = useRef(false);
  const toggleDetails = (event: React.MouseEvent<HTMLButtonElement>) => {
    const wasOpen = event.detail === 0 ? open : openOnPointerDown.current;
    closeFocusRef.current = event.currentTarget;
    dismissedOutside.current = false;
    // Keep the current anchor through exit animation; only opening picks a new one.
    if (!wasOpen) triggerRef.current = event.currentTarget;
    setOpen(!wasOpen);
  };
  const status = isError ? "Unavailable" : pr.status;
  const Icon = STATES[status].icon;
  const ref = identity(pr.url);
  const ci = ciPresentation(isError ? undefined : pr.ci);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor virtualRef={triggerRef} />
      <div
        data-testid="agent-pr-line"
        className="grid h-7 min-w-0 grid-cols-[14px_minmax(0,1fr)] items-center gap-3"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          data-agent-control="true"
          aria-label={`Details for pull request ${ref.number}: ${STATES[status].label}`}
          title="Pull request details"
          onPointerDownCapture={() => {
            openOnPointerDown.current = open;
          }}
          onClick={toggleDetails}
          data-pr-details-trigger={contentId}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          className="justify-self-center hover:bg-muted/50 data-[state=open]:bg-muted/50"
        >
          <Icon
            aria-hidden="true"
            className={cn("h-3.5 w-3.5", STATES[status].color)}
          />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <AgentMetadataLink
            data-agent-control="true"
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Pull request ${ref.number}: ${STATES[status].label} — ${pr.title}`}
            title={`${ref.repo} ${ref.number} · ${STATES[status].label}`}
            className="mr-auto"
          >
            {ref.number === "PR" ? "PR" : `PR ${ref.number}`}
            <span className="sr-only">{STATES[status].label}</span>
          </AgentMetadataLink>
          {!isError && risk && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              data-agent-control="true"
              aria-label={`Merge risk for pull request ${ref.number}: ${riskDisplay(risk).label}`}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              onPointerDownCapture={() => {
                openOnPointerDown.current = open;
              }}
              onClick={toggleDetails}
              data-pr-details-trigger={contentId}
            >
              <MergeRiskMarker risk={risk} />
            </Button>
          )}
          {(isError ||
            pr.ci?.availability !== "available" ||
            pr.ci.summary.total > 0) && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              data-agent-control="true"
              aria-label={`Check details for pull request ${ref.number}`}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              onPointerDownCapture={() => {
                openOnPointerDown.current = open;
              }}
              onClick={toggleDetails}
              data-pr-details-trigger={contentId}
            >
              <CompactChecks ci={isError ? undefined : pr.ci} />
            </Button>
          )}
          <AgentLinkControls
            url={pr.url}
            copyLabel={`Copy pull request ${ref.number} URL`}
            copiedLabel={`Copied pull request ${ref.number} URL`}
            dismissLabel={`Dismiss ${ref.repo} ${ref.number} from sidebar`}
            onDismiss={onDismiss}
          />
        </div>
      </div>
      <PopoverContent
        id={contentId}
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (
            target instanceof Element &&
            target
              .closest("[data-pr-details-trigger]")
              ?.getAttribute("data-pr-details-trigger") === contentId
          ) {
            event.preventDefault();
          } else {
            dismissedOutside.current = true;
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!dismissedOutside.current) {
            (closeFocusRef.current ?? triggerRef.current)?.focus();
          }
          dismissedOutside.current = false;
        }}
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        data-agent-control="true"
        className="max-h-[var(--radix-popper-available-height)] w-[360px] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-0"
      >
        <PopoverArrow />
        <div className="px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Pull request {ref.number}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="mt-2 text-xs font-medium">{pr.title}</p>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-status-done underline underline-offset-4"
          >
            Open on GitHub{" "}
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
          </a>
        </div>
        <>
          {!isError && risk && (
            <MergeRiskDetails
              risk={risk}
              ci={pr.ci}
              agentId={agentId}
              url={pr.url}
            />
          )}
          <div className="border-t border-border p-3">
            <h4 className="text-xs font-semibold">Checks</h4>
            {(pr.ci?.availability !== "available" || !pr.ci?.checks.length) && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {ci.label}
              </p>
            )}
          </div>
          {pr.ci?.availability === "available" && (
            <ul className="max-h-64 overflow-y-auto px-3 pb-3">
              {[...pr.ci.checks]
                .sort(
                  (a, b) =>
                    a.name.localeCompare(b.name) ||
                    (a.detailsUrl ?? "").localeCompare(b.detailsUrl ?? "")
                )
                .map((check, index) => {
                  const result = checkResult(check);
                  const CheckIcon = result.icon;
                  const duration = checkDuration(check, pr.ci!.checkedAt);
                  return (
                    <li
                      key={`${check.name}-${index}`}
                      className="flex items-center gap-2 border-b border-border/40 py-2 text-[11px] last:border-0"
                    >
                      <span
                        role="img"
                        aria-label={result.label}
                        title={result.label}
                        className="shrink-0"
                      >
                        <CheckIcon
                          aria-hidden="true"
                          className={cn("h-3.5 w-3.5", result.color)}
                        />
                      </span>
                      {check.detailsUrl ? (
                        <a
                          href={check.detailsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-w-0 flex-1 items-center gap-1.5 hover:underline"
                        >
                          <span className="truncate">{check.name}</span>
                          <ExternalLink
                            aria-hidden="true"
                            className="h-2.5 w-2.5 shrink-0 text-muted-foreground"
                          />
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">
                          {check.name}
                        </span>
                      )}
                      {duration && (
                        <span
                          className="shrink-0 tabular-nums text-muted-foreground"
                          title={
                            check.completedAt
                              ? "Check duration"
                              : `Elapsed at last refresh (${pr.ci!.checkedAt})`
                          }
                        >
                          {duration}
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
          {refresh?.isPending && (
            <p
              role="status"
              className="px-3 pb-2 text-[11px] text-muted-foreground"
            >
              Refreshing checks…
            </p>
          )}
          {refresh?.isError && (
            <p
              role="alert"
              className="px-3 pb-3 break-words text-[11px] leading-relaxed text-destructive"
            >
              {refresh.error instanceof Error
                ? refresh.error.message
                : "Could not refresh. Please try again."}
            </p>
          )}
          {(pr.ci || refresh) && (
            <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span title={pr.ci?.checkedAt}>
                  Last checked{" "}
                  {pr.ci
                    ? new Date(pr.ci.checkedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Never"}
                </span>
                {refresh && <RefreshPullRequest refresh={refresh} />}
                <span className="ml-auto">
                  Commit{" "}
                  <span className="font-mono">
                    {pr.ci?.headSha.slice(0, 7) || "Unknown"}
                  </span>
                </span>
              </div>
            </div>
          )}
        </>
      </PopoverContent>
    </Popover>
  );
}

function RefreshablePullRequestRow({
  agentId,
  ...props
}: Omit<React.ComponentProps<typeof PullRequestRow>, "refresh"> & {
  agentId: string;
}) {
  const refresh = usePullRequestRefresh(agentId, props.pr.url);
  return <PullRequestRow {...props} agentId={agentId} refresh={refresh} />;
}

function usePullRequestRefresh(agentId: string, url: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api(`/api/v1/agents/${agentId}/pull-requests/refresh`, {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    onSuccess: async () => {
      // Read the current server snapshot rather than installing a response that
      // could race dismissal or a newer SSE observation.
      await client.invalidateQueries({
        queryKey: ["agent-pull-requests", agentId],
      });
    },
  });
}

function RefreshPullRequest({
  refresh,
}: {
  refresh: ReturnType<typeof usePullRequestRefresh>;
}) {
  return (
    <div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh pull request checks"
        title="Refresh pull request checks"
        disabled={refresh.isPending}
        aria-busy={refresh.isPending}
        onClick={() => {
          if (!refresh.isPending) refresh.mutate();
        }}
      >
        <RefreshCw
          aria-hidden="true"
          className={cn("h-3 w-3", refresh.isPending && "animate-spin")}
        />
      </Button>
    </div>
  );
}
