import { useId, useRef, useState } from "react";
import { previewPullRequests } from "./agent-pull-requests.preview";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  X,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverArrow,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentPullRequest } from "@dispatch/shared";

type Status = AgentPullRequest["status"];
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

/** Presentation contract for the CI design preview; collection is not wired yet. */
type CiSnapshot = {
  checkedAt: string;
  headSha: string;
  availability: "available" | "unavailable";
  summary: {
    status: "passing" | "failing" | "pending" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
  };
  checks: {
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
  }[];
};
export type PresentedPullRequest = AgentPullRequest & { ci?: CiSnapshot };

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

function CompactChecks({ ci }: { ci?: CiSnapshot }) {
  const state = ciPresentation(ci);
  if (!ci || ci.availability === "unavailable" || ci.summary.total === 0) {
    const Icon = state.icon;
    return (
      <span
        role="img"
        aria-label={state.label}
        title={state.label}
        className="shrink-0 text-muted-foreground"
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (ci.summary.pending === ci.summary.total) {
    return (
      <span
        role="img"
        aria-label={`Checks: ${ci.summary.pending} pending`}
        title={`${ci.summary.pending} checks pending`}
        className="inline-flex h-3.5 w-3.5 items-center justify-center text-status-waiting"
      >
        <Clock aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
      </span>
    );
  }
  const groups = [
    {
      label: "passed",
      count: ci.summary.passed,
      icon: CircleCheck,
      color: "text-status-working",
    },
    {
      label: "failed",
      count: ci.summary.failed,
      icon: CircleX,
      color: "text-status-blocked",
    },
    {
      label: "pending",
      count: ci.summary.pending,
      icon: Clock3,
      color: "text-status-waiting",
    },
    {
      label: "skipped",
      count: ci.summary.skipped,
      icon: Minus,
      color: "text-muted-foreground/30",
    },
  ].filter((group) => group.count > 0);
  const label = groups
    .map((group) => `${group.count} ${group.label}`)
    .join(", ");
  let offset = 0;
  return (
    <span
      role="img"
      aria-label={`Checks: ${label}`}
      title={`${ci.summary.total} checks: ${label}`}
      className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="block h-3.5 w-3.5">
        <circle
          cx="12"
          cy="12"
          r="9.25"
          fill="currentColor"
          fillOpacity={0.1}
          className={state.color}
        />
        {groups.map(({ label, count, color }) => {
          const share = (count / ci.summary.total) * 100;
          const start = offset;
          offset += share;
          return (
            <circle
              key={label}
              cx="12"
              cy="12"
              r="10"
              transform="rotate(-90 12 12)"
              pathLength="100"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray={`${Math.max(0, share - (groups.length > 1 ? 2 : 0))} 100`}
              strokeDashoffset={-start}
              className={color}
            />
          );
        })}
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={state.color}
        >
          {ci.summary.failed ? (
            <path d="M8 8 L16 16 M16 8 L8 16" />
          ) : ci.summary.pending ? (
            <>
              <circle cx="12" cy="12" r="4.25" />
              <path d="M12 9.5 V12 L14 13.25" />
            </>
          ) : ci.summary.passed ? (
            <path d="M7.5 12 L10.5 15 L16.5 9" />
          ) : (
            <path d="M8 12 H16" />
          )}
        </g>
      </svg>
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
    <div data-testid={`agent-pr-row-${agentId}`} className="space-y-1">
      {hasDismissError && (
        <p role="alert" className="text-xs text-destructive">
          Could not dismiss PR. Please try again.
        </p>
      )}
      {prs
        .filter((pr) => !hidden.includes(`${agentId}:${pr.url}`))
        .map((pr) => (
          <PullRequestRow
            key={pr.url}
            pr={pr}
            onDismiss={() => dismiss.mutate(pr.url)}
            agentName={agentName}
            isError={isError}
          />
        ))}
    </div>
  );
}

function PullRequestRow({
  onDismiss,
  pr,
  isError,
}: {
  onDismiss: () => void;
  pr: PresentedPullRequest;
  agentName?: string;
  isError: boolean;
}) {
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
          <a
            data-agent-control="true"
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Pull request ${ref.number}: ${STATES[status].label} — ${pr.title}`}
            title={`${ref.repo} ${ref.number} · ${STATES[status].label}`}
            className="group inline-flex h-5 shrink-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="max-w-16 truncate font-mono text-[11px] leading-none text-foreground group-hover:underline">
              {ref.number}
            </span>
            <ExternalLink
              aria-hidden="true"
              className="h-2.5 w-2.5 text-muted-foreground"
            />
            <span className="sr-only">{STATES[status].label}</span>
          </a>
          <Button
            variant="ghost"
            size="icon-sm"
            data-agent-control="true"
            aria-label={`Dismiss ${ref.repo} ${ref.number} from sidebar`}
            title={`Dismiss ${ref.repo} ${ref.number} from sidebar`}
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          {pr.ci && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
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
        className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0"
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
        {pr.ci && (
          <>
            <div className="border-t border-border px-3 pt-3 pb-2">
              <h4 className="text-xs font-semibold">Checks</h4>
              {(pr.ci.availability !== "available" || !pr.ci.checks.length) && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {ci.label}
                </p>
              )}
            </div>
            {pr.ci.availability === "available" && (
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
                    return (
                      <li
                        key={`${check.name}-${index}`}
                        className="flex items-center gap-2 border-b border-border/40 py-2 text-[11px] last:border-0"
                      >
                        <CheckIcon
                          aria-hidden="true"
                          className={cn("h-3.5 w-3.5 shrink-0", result.color)}
                        />
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
                        <span className={cn("shrink-0", result.color)}>
                          {result.label}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
            <div className="flex justify-between gap-3 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
              <span title={pr.ci.checkedAt}>
                Checked{" "}
                {new Date(pr.ci.checkedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span>
                Commit{" "}
                <span className="font-mono">{pr.ci.headSha.slice(0, 7)}</span>
              </span>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
