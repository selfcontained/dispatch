import { type ReactNode, useState } from "react";
import {
  Archive,
  ChevronDown,
  CirclePause,
  Monitor,
  Play,
  Smartphone,
  Sparkles,
} from "lucide-react";

import { AgentMeta, FrontTruncatedValue } from "@/components/app/agent-meta";
import { formatRelativeTime } from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ThemeId, THEMES, useTheme } from "@/hooks/use-theme";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

type ScenarioId =
  | "review-unresolved"
  | "review-resolved"
  | "running-no-review"
  | "paused";
type Viewport = "desktop" | "mobile";
type SidebarVariant = "current" | "summary-first" | "compact-meta";

type FeedbackItem = {
  id: number;
  file: string;
  title: string;
  severity: "high" | "medium" | "low";
  status: "open" | "fixed" | "ignored";
};

type Reviewer = {
  id: string;
  name: string;
  verdict: "approve" | "changes_requested" | "reviewing";
  unresolved: number;
  resolved: number;
  summary: string;
  feedback: FeedbackItem[];
};

type Scenario = {
  id: ScenarioId;
  name: string;
  agentType: AgentType;
  status: "Done" | "Working" | "Paused";
  statusTone: "done" | "working" | "paused";
  updatedAt: string;
  event: string;
  reviewHistory: boolean;
  reviewSummary?: string;
  repo: string;
  baseBranch: string;
  worktreeBranch: string;
  worktreePath: string;
  fullAccess: boolean;
  reviewers: Reviewer[];
};

const now = Date.now();
const minutesAgo = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString();

const scenarios: Scenario[] = [
  {
    id: "review-unresolved",
    name: "web notification ack flow",
    agentType: "claude",
    status: "Done",
    statusTone: "done",
    updatedAt: minutesAgo(2),
    event: "Added 5 E2E tests for notification ack flow",
    reviewHistory: true,
    reviewSummary: "2 unresolved · Approved by 1 reviewer",
    repo: "dispatch",
    baseBranch: "main",
    worktreeBranch: "agt_573b28ecc432/agent-ecc432",
    worktreePath:
      "/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-573b28ecc432-agent-ecc432",
    fullAccess: true,
    reviewers: [
      {
        id: "architecture-review",
        name: "architecture-review",
        verdict: "approve",
        unresolved: 2,
        resolved: 2,
        summary:
          "Approved, but two issues still need attention before closing the loop.",
        feedback: [
          {
            id: 1,
            file: "server.ts:117",
            title: "pendingWebNotification state can linger after reconnect",
            severity: "high",
            status: "open",
          },
          {
            id: 2,
            file: "slack.ts:150",
            title: "ack retry path should emit one terminal-facing event",
            severity: "medium",
            status: "open",
          },
          {
            id: 3,
            file: "server.ts:128",
            title: "latest-event text can drift from the SSE event source",
            severity: "low",
            status: "ignored",
          },
          {
            id: 4,
            file: "server.ts:1071",
            title: "issue summary should mention delivery channel",
            severity: "low",
            status: "fixed",
          },
        ],
      },
    ],
  },
  {
    id: "review-resolved",
    name: "agent detail IA pass with extra-long realistic naming",
    agentType: "codex",
    status: "Done",
    statusTone: "done",
    updatedAt: minutesAgo(9),
    event: "Resolved the last review note and updated the design spec doc",
    reviewHistory: true,
    reviewSummary: "Approved by 2 reviewers",
    repo: "dispatch",
    baseBranch: "release/0.14",
    worktreeBranch: "agt_release/agent-6f1441",
    worktreePath:
      "/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-release-agent-6f1441",
    fullAccess: false,
    reviewers: [
      {
        id: "ux-review",
        name: "frontend-ux-review",
        verdict: "approve",
        unresolved: 0,
        resolved: 3,
        summary: "Interaction details look good after the second pass.",
        feedback: [
          {
            id: 5,
            file: "agent-card.tsx:42",
            title: "name clipping eased after moving destructive actions",
            severity: "low",
            status: "fixed",
          },
          {
            id: 6,
            file: "feedback-panel.tsx:201",
            title: "badge hierarchy now matches review urgency",
            severity: "low",
            status: "fixed",
          },
          {
            id: 7,
            file: "design-lab.tsx:88",
            title: "prototype controls mirror actual interaction model",
            severity: "low",
            status: "ignored",
          },
        ],
      },
      {
        id: "product-review",
        name: "product-review",
        verdict: "approve",
        unresolved: 0,
        resolved: 1,
        summary:
          "Scope looks appropriate and the information hierarchy is clearer.",
        feedback: [
          {
            id: 8,
            file: "design-lab.tsx:120",
            title: "mode naming is clearer than before",
            severity: "low",
            status: "fixed",
          },
        ],
      },
    ],
  },
  {
    id: "running-no-review",
    name: "design-lab-v2 prototype surface",
    agentType: "codex",
    status: "Working",
    statusTone: "working",
    updatedAt: new Date(now).toISOString(),
    event: "Implementing sidebar-only variation surface in the design lab",
    reviewHistory: false,
    repo: "dispatch",
    baseBranch: "main",
    worktreeBranch: "agt_91d1e714/design-lab-v2",
    worktreePath:
      "/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-91d1e714-design-lab-v2",
    fullAccess: true,
    reviewers: [],
  },
  {
    id: "paused",
    name: "migration follow-up cleanup",
    agentType: "claude",
    status: "Paused",
    statusTone: "paused",
    updatedAt: minutesAgo(14),
    event: "Paused after hitting a failing migration locally",
    reviewHistory: false,
    repo: "dispatch",
    baseBranch: "main",
    worktreeBranch: "agt_71de23aa/db-fix",
    worktreePath:
      "/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-71de23aa-db-fix",
    fullAccess: true,
    reviewers: [],
  },
];

const variantMeta: Record<
  SidebarVariant,
  { title: string; description: string }
> = {
  current: {
    title: "Current-ish",
    description: "Close to today, but with the header already cleaned up.",
  },
  "summary-first": {
    title: "Summary First",
    description:
      "Review signal moved up; metadata and session actions pushed down.",
  },
  "compact-meta": {
    title: "Compact Meta",
    description:
      "Metadata compressed harder so status and review get more room.",
  },
};

const allVariants: SidebarVariant[] = [
  "current",
  "summary-first",
  "compact-meta",
];

const statusToneClass = {
  done: "text-status-done",
  working: "text-status-working",
  paused: "text-status-waiting",
};

const severityDotClass = {
  high: "bg-status-blocked",
  medium: "bg-status-waiting",
  low: "bg-status-working",
};

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">
      {children}
    </div>
  );
}

function ToolbarButton({
  active = false,
  children,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function SidebarHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="border-b border-border px-3 py-3">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </div>
  );
}

function ReviewerSummary({
  reviewer,
  variant,
}: {
  reviewer: Reviewer;
  variant: SidebarVariant;
}) {
  const openItems = reviewer.feedback.filter((item) => item.status === "open");
  const resolvedCount = reviewer.feedback.length - openItems.length;
  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-background/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {reviewer.name}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {reviewer.verdict === "reviewing"
              ? "Reviewing"
              : reviewer.verdict === "approve"
                ? "Approved"
                : "Changes requested"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {reviewer.unresolved > 0 ? (
            <Badge variant="stopped" className="normal-case tracking-normal">
              {reviewer.unresolved}
            </Badge>
          ) : null}
          {resolvedCount > 0 ? (
            <Badge variant="default" className="normal-case tracking-normal">
              {resolvedCount}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        {openItems.slice(0, variant === "compact-meta" ? 1 : 2).map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded-lg px-1 py-1 text-[11px]"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                severityDotClass[item.severity]
              )}
            />
            <span className="shrink-0 font-mono text-muted-foreground">
              {item.file}
            </span>
            <span className="min-w-0 truncate text-foreground">
              {item.title}
            </span>
          </div>
        ))}
        {reviewer.unresolved === 0 ? (
          <div className="text-[11px] text-muted-foreground">
            No unresolved findings.
          </div>
        ) : null}
        {resolvedCount > 0 ? (
          <div className="text-[11px] text-muted-foreground">
            {resolvedCount} resolved hidden by default
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RealisticAgentCard({
  scenario,
  expanded,
  variant,
  selected,
  onToggle,
}: {
  scenario: Scenario;
  expanded: boolean;
  variant: SidebarVariant;
  selected?: boolean;
  onToggle: () => void;
}) {
  const unresolvedCount = scenario.reviewers.reduce(
    (sum, reviewer) => sum + reviewer.unresolved,
    0
  );
  const showReviewRow = scenario.reviewHistory;
  const showCompactContext = variant === "compact-meta";
  const showSummaryBeforeContext = variant !== "current";

  const overview = (
    <>
      <div className="mt-1 flex min-w-0 items-baseline text-xs text-muted-foreground">
        <span
          className={cn(
            "shrink-0 font-medium",
            statusToneClass[scenario.statusTone]
          )}
        >
          {scenario.status}
        </span>
        <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
        <span className="shrink-0">
          {formatRelativeTime(scenario.updatedAt)}
        </span>
        <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
        <span className="min-w-0 truncate">{scenario.event}</span>
      </div>

      {showReviewRow ? (
        <div className="mt-2 flex min-w-0 items-center justify-between gap-2 rounded-lg border border-primary/15 bg-primary/[0.04] px-3 py-2">
          <div className="min-w-0 truncate text-sm font-medium text-foreground">
            {scenario.reviewSummary}
          </div>
          <Badge
            variant={unresolvedCount > 0 ? "stopped" : "transitional"}
            className="normal-case tracking-normal"
          >
            {unresolvedCount > 0 ? "Needs attention" : "Reviewed"}
          </Badge>
        </div>
      ) : null}
    </>
  );

  const contextSection = showCompactContext ? (
    <div className="grid gap-2 rounded-xl border border-border/60 bg-background/30 p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Repo</span>
        <span className="font-medium text-foreground">{scenario.repo}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Branch</span>
        <span className="truncate text-right font-mono text-foreground">
          {scenario.baseBranch}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Runtime</span>
        <span className="font-medium text-foreground">
          {AGENT_TYPE_LABELS[scenario.agentType]} ·{" "}
          {scenario.fullAccess ? "Full access" : "Sandboxed"}
        </span>
      </div>
    </div>
  ) : (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <AgentMeta label="Repo" value={scenario.repo} />
      <div className="grid gap-1">
        <SectionLabel>Branch</SectionLabel>
        <div className="grid gap-0">
          <div className="text-muted-foreground">
            <FrontTruncatedValue
              value={scenario.baseBranch}
              mono
              className="text-muted-foreground"
              tooltipClassName=""
              tooltipValue={`Base branch: ${scenario.baseBranch}`}
            />
          </div>
          <div className="flex items-center gap-1 pl-1">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">
              └
            </span>
            <FrontTruncatedValue
              value={scenario.worktreeBranch}
              mono
              tooltipValue={`Working branch: ${scenario.worktreeBranch}`}
            />
          </div>
        </div>
      </div>
      <AgentMeta
        label="Worktree"
        value={scenario.worktreePath}
        mono
        truncateStart
      />
      <div className="flex items-center justify-between">
        <div className="text-foreground">
          {AGENT_TYPE_LABELS[scenario.agentType]}
        </div>
        <div
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px]",
            scenario.fullAccess
              ? "border border-status-waiting/45 bg-status-waiting/15 text-status-waiting"
              : "text-foreground"
          )}
        >
          {scenario.fullAccess ? "Full access" : "Sandboxed"}
        </div>
      </div>
    </div>
  );

  const reviewSection = scenario.reviewHistory ? (
    <div className="space-y-2">
      <SectionLabel>
        {variant === "current" ? "Reviewers" : "Review"}
      </SectionLabel>
      {variant !== "current" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="default" className="gap-2">
            <Sparkles className="h-3.5 w-3.5" />
            Launch Reviewer
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        {scenario.reviewers.map((reviewer) => (
          <ReviewerSummary
            key={reviewer.id}
            reviewer={reviewer}
            variant={variant}
          />
        ))}
      </div>
    </div>
  ) : (
    <div className="space-y-2">
      <SectionLabel>Review</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="default" className="gap-2">
          <Sparkles className="h-3.5 w-3.5" />
          Launch Reviewer
        </Button>
        <Badge variant="default" className="normal-case tracking-normal">
          No review history
        </Badge>
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        "border-b border-r-4 px-2 py-2 transition-colors duration-300",
        selected ? "bg-muted/60 border-r-status-done" : "border-r-transparent"
      )}
    >
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex flex-1 items-center gap-2 text-left text-sm font-semibold">
          <AgentTypeIcon
            type={scenario.agentType}
            eventType={scenario.status === "Paused" ? null : "done"}
          />
          <span className="truncate">{scenario.name}</span>
        </div>

        {scenario.status === "Paused" ? (
          <Button size="icon" variant="ghost-info">
            <Play className="h-3.5 w-3.5" />
          </Button>
        ) : null}

        <Button size="icon" variant="ghost" onClick={onToggle}>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-180"
            )}
          />
        </Button>
      </div>

      {overview}

      {expanded ? (
        <div className="mt-2 space-y-3 overflow-hidden px-3 pb-2 pt-1">
          {showSummaryBeforeContext ? reviewSection : contextSection}
          {showSummaryBeforeContext ? contextSection : reviewSection}

          <div className="space-y-2">
            <SectionLabel>Session actions</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {scenario.status === "Paused" ? (
                <Button size="sm" variant="ghost-info" className="gap-2">
                  <Play className="h-3.5 w-3.5" />
                  Resume
                </Button>
              ) : (
                <Button size="sm" variant="ghost-warning" className="gap-2">
                  <CirclePause className="h-3.5 w-3.5" />
                  Pause
                </Button>
              )}
              <Button size="sm" variant="ghost-destructive" className="gap-2">
                <Archive className="h-3.5 w-3.5" />
                Archive
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SidebarPane({
  variant,
  viewport,
}: {
  variant: SidebarVariant;
  viewport: Viewport;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<ScenarioId>>(
    new Set(["review-unresolved", "running-no-review"])
  );

  const widthClass = viewport === "mobile" ? "w-full" : "w-[350px]";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-card",
        widthClass
      )}
    >
      <SidebarHeader
        title={variantMeta[variant].title}
        description={variantMeta[variant].description}
      />
      <div className="flex h-full min-h-0 flex-col">
        <div className="mt-2 flex h-14 items-center border-b border-border px-3">
          <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Agents
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="default" className="gap-2">
              <AgentTypeIcon
                type="codex"
                className="border-none bg-transparent p-0 text-foreground/80"
              />
              Create
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {scenarios.map((scenario, index) => (
            <RealisticAgentCard
              key={`${variant}-${scenario.id}`}
              scenario={scenario}
              variant={variant}
              selected={index === 0}
              expanded={expandedIds.has(scenario.id)}
              onToggle={() =>
                setExpandedIds((current) => {
                  const next = new Set(current);
                  if (next.has(scenario.id)) next.delete(scenario.id);
                  else next.add(scenario.id);
                  return next;
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DesignLabPrototypePlayground(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [mobileVariant, setMobileVariant] =
    useState<SidebarVariant>("summary-first");

  const visibleVariants =
    viewport === "desktop" ? allVariants : [mobileVariant];

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-border/70 bg-card/70 p-6 backdrop-blur-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.16em] text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Sidebar Variations
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
              Realistic sidebar studies using Dispatch UI primitives
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This is no longer a wireframe. Each variation uses realistic agent
              data, real component primitives, and the same density problems the
              actual sidebar has today so the comparisons are more trustworthy.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:w-[520px]">
            <div className="rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs">
              Theme switcher
            </div>
            <div className="rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs">
              Desktop/mobile presets
            </div>
            <div className="rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs">
              State gallery
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[220px_220px_1fr]">
          <div className="space-y-2">
            <SectionLabel>Theme</SectionLabel>
            <Select
              value={theme}
              onValueChange={(value) => setTheme(value as ThemeId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                {THEMES.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <SectionLabel>Viewport</SectionLabel>
            <div className="flex gap-2">
              <ToolbarButton
                active={viewport === "desktop"}
                onClick={() => setViewport("desktop")}
              >
                <Monitor className="mr-1.5 inline h-3.5 w-3.5" />
                Desktop
              </ToolbarButton>
              <ToolbarButton
                active={viewport === "mobile"}
                onClick={() => setViewport("mobile")}
              >
                <Smartphone className="mr-1.5 inline h-3.5 w-3.5" />
                Mobile
              </ToolbarButton>
            </div>
          </div>

          <div className="space-y-2">
            <SectionLabel>Focus</SectionLabel>
            {viewport === "mobile" ? (
              <div className="flex flex-wrap gap-2">
                {allVariants.map((variant) => (
                  <ToolbarButton
                    key={variant}
                    active={mobileVariant === variant}
                    onClick={() => setMobileVariant(variant)}
                  >
                    {variantMeta[variant].title}
                  </ToolbarButton>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border/70 bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                Desktop shows all three sidebar variations side by side for
                direct comparison.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-border/70 bg-surface/80 p-4 lg:p-6">
        <div
          className={cn(
            "gap-4",
            viewport === "desktop"
              ? "grid xl:grid-cols-3"
              : "flex justify-center"
          )}
        >
          {visibleVariants.map((variant) => (
            <SidebarPane key={variant} variant={variant} viewport={viewport} />
          ))}
        </div>
      </div>
    </div>
  );
}
