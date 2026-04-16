import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  Bot,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  CirclePause,
  ExternalLink,
  FolderGit2,
  MessageSquareText,
  Monitor,
  MoonStar,
  PanelRight,
  Pin,
  Play,
  Smartphone,
  Sparkles,
  Terminal,
} from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ThemeId, THEMES, useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

type ScenarioId =
  | "review-unresolved"
  | "review-resolved"
  | "running-no-review"
  | "paused";
type Viewport = "desktop" | "mobile";
type RightTab = "feedback" | "pins" | "media";

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
  summary: string;
  unresolved: number;
  resolved: number;
  feedback: FeedbackItem[];
};

type Scenario = {
  id: ScenarioId;
  label: string;
  description: string;
  status: "Done" | "Working" | "Paused";
  statusTone: "done" | "working" | "paused";
  timeAgo: string;
  event: string;
  reviewHistory: boolean;
  reviewers: Reviewer[];
  repo: string;
  baseBranch: string;
  worktreeBranch: string;
  worktreePath: string;
  runtime: string;
  access: "Full access" | "Sandboxed";
  reviewSummary?: string;
};

const prototypeScenarios: Scenario[] = [
  {
    id: "review-unresolved",
    label: "Reviewed with unresolved feedback",
    description:
      "Target state for the redesign: reviewed agent, unresolved findings, Feedback tab first.",
    status: "Done",
    statusTone: "done",
    timeAgo: "2m ago",
    event: "Added 5 E2E tests for notification ack flow",
    reviewHistory: true,
    reviewSummary: "2 unresolved · Approved by 1 reviewer",
    repo: "dispatch",
    baseBranch: "main",
    worktreeBranch: "agt_573b28ecc432/agent-ecc432",
    worktreePath: ".../worktrees/agt-573b28ecc432-agent-ecc432",
    runtime: "Claude",
    access: "Full access",
    reviewers: [
      {
        id: "arch-review",
        name: "architecture-review",
        verdict: "approve",
        summary: "Approved with a couple of follow-up cleanup items.",
        unresolved: 2,
        resolved: 2,
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
            title: "Latest-event message text can drift from actual SSE event",
            severity: "low",
            status: "ignored",
          },
          {
            id: 4,
            file: "server.ts:1071",
            title: "Issue summary should include delivery channel",
            severity: "low",
            status: "fixed",
          },
        ],
      },
    ],
  },
  {
    id: "review-resolved",
    label: "Reviewed with everything resolved",
    description:
      "Feedback tab still exists because review history exists, but the agent no longer needs action.",
    status: "Done",
    statusTone: "done",
    timeAgo: "9m ago",
    event: "Finished cleanup pass and resolved reviewer feedback",
    reviewHistory: true,
    reviewSummary: "Approved by 2 reviewers",
    repo: "dispatch",
    baseBranch: "release/0.14",
    worktreeBranch: "agt_release/agent-6f1441",
    worktreePath: ".../worktrees/agt-release-agent-6f1441",
    runtime: "Codex",
    access: "Sandboxed",
    reviewers: [
      {
        id: "ux-review",
        name: "ux-review",
        verdict: "approve",
        summary: "Interaction details look good after the second pass.",
        unresolved: 0,
        resolved: 3,
        feedback: [
          {
            id: 5,
            file: "agent-card.tsx:42",
            title: "Name clipping eased after moving destructive actions",
            severity: "low",
            status: "fixed",
          },
          {
            id: 6,
            file: "feedback-panel.tsx:201",
            title: "Badge hierarchy now matches review urgency",
            severity: "low",
            status: "fixed",
          },
          {
            id: 7,
            file: "design-lab.tsx:88",
            title: "Prototype controls mirror actual interaction model",
            severity: "low",
            status: "ignored",
          },
        ],
      },
    ],
  },
  {
    id: "running-no-review",
    label: "Running with no review history",
    description:
      "Agent is active and has no review history yet, so there is no Feedback tab.",
    status: "Working",
    statusTone: "working",
    timeAgo: "just now",
    event: "Implementing dedicated feedback tab scaffolding",
    reviewHistory: false,
    repo: "dispatch",
    baseBranch: "main",
    worktreeBranch: "agt_91d1e714/design-lab-v2",
    worktreePath: ".../worktrees/agt-91d1e714-design-lab-v2",
    runtime: "Codex",
    access: "Full access",
    reviewers: [],
  },
  {
    id: "paused",
    label: "Paused agent",
    description:
      "Collapsed card shows resume because it is the only lifecycle action that still matters at a glance.",
    status: "Paused",
    statusTone: "paused",
    timeAgo: "14m ago",
    event: "Paused after hitting a failing migration locally",
    reviewHistory: false,
    repo: "dispatch",
    baseBranch: "main",
    worktreeBranch: "agt_71de23aa/db-fix",
    worktreePath: ".../worktrees/agt-71de23aa-db-fix",
    runtime: "Claude",
    access: "Full access",
    reviewers: [],
  },
];

const toneClasses = {
  done: "text-status-done",
  working: "text-status-working",
  paused: "text-status-waiting",
};

const feedbackDot = {
  high: "bg-status-blocked",
  medium: "bg-status-waiting",
  low: "bg-status-working",
};

function StatPill({
  icon: Icon,
  label,
  tone = "default",
}: {
  icon: typeof Sparkles;
  label: string;
  tone?: "default" | "alert" | "positive";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
        tone === "alert" && "border-status-waiting/35 bg-status-waiting/10",
        tone === "positive" && "border-status-done/35 bg-status-done/10",
        tone === "default" && "border-border bg-card/70"
      )}
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span>{label}</span>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
      {children}
    </div>
  );
}

function RowAction({
  children,
  active = false,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card/70 text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function AgentSummaryCard({
  scenario,
  expanded,
}: {
  scenario: Scenario;
  expanded: boolean;
}) {
  const isPaused = scenario.status === "Paused";
  const unresolvedCount = scenario.reviewers.reduce(
    (sum, reviewer) => sum + reviewer.unresolved,
    0
  );

  return (
    <div className="rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            web notification ack flow
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isPaused ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-status-done/35 bg-status-done/10 text-status-done"
              title="Resume"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground"
              title="Connect parent session"
            >
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              Connected
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground"
            title={expanded ? "Collapse" : "Expand"}
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-180"
              )}
            />
          </button>
        </div>
      </div>

      <div className="mt-3 flex min-w-0 items-baseline text-xs text-muted-foreground">
        <span
          className={cn(
            "shrink-0 font-medium",
            toneClasses[scenario.statusTone]
          )}
        >
          {scenario.status}
        </span>
        <span className="mx-1.5 shrink-0 text-muted-foreground/60">•</span>
        <span className="shrink-0">{scenario.timeAgo}</span>
        <span className="mx-1.5 shrink-0 text-muted-foreground/60">•</span>
        <span className="min-w-0 truncate">{scenario.event}</span>
      </div>

      {scenario.reviewHistory ? (
        <button
          type="button"
          className="mt-3 flex w-full items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-left"
        >
          <div className="flex items-center gap-2 text-sm">
            {unresolvedCount > 0 ? (
              <CircleAlert className="h-4 w-4 text-status-waiting" />
            ) : (
              <CheckCheck className="h-4 w-4 text-status-done" />
            )}
            <span className="font-medium text-foreground">
              {scenario.reviewSummary}
            </span>
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      ) : null}

      {expanded ? (
        <div className="mt-4 space-y-4 border-t border-border/70 pt-4">
          <div className="space-y-2">
            <Label>Review</Label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground"
              >
                <Sparkles className="h-4 w-4 text-primary" />
                Launch Reviewer
              </button>
              <div className="rounded-full border border-status-done/35 bg-status-done/10 px-2.5 py-1 text-[11px] font-medium text-status-done">
                Parent connected
              </div>
              {scenario.reviewHistory ? (
                <button
                  type="button"
                  className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                >
                  Open Feedback
                </button>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              {scenario.reviewHistory
                ? "Feedback becomes the first detail tab once review history exists."
                : "No review history yet, so the right pane starts with Pins."}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Context</Label>
            <div className="grid gap-2 rounded-xl border border-border/70 bg-background/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Repo</span>
                <span className="font-medium text-foreground">
                  {scenario.repo}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Branch</span>
                <span className="truncate text-right font-mono text-foreground">
                  {scenario.baseBranch}{" "}
                  <ArrowRight className="mx-1 inline h-3 w-3" />
                  {scenario.worktreeBranch}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Worktree</span>
                <span className="truncate text-right font-mono text-foreground">
                  {scenario.worktreePath}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Runtime</span>
                <span className="font-medium text-foreground">
                  {scenario.runtime} · {scenario.access}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Session actions</Label>
            <div className="flex flex-wrap gap-2">
              {isPaused ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-xl border border-status-done/35 bg-status-done/10 px-3 py-2 text-sm font-medium text-status-done"
                >
                  <Play className="h-4 w-4" />
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-xl border border-status-waiting/35 bg-status-waiting/10 px-3 py-2 text-sm font-medium text-status-waiting"
                >
                  <CirclePause className="h-4 w-4" />
                  Pause
                </button>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-status-blocked/35 bg-status-blocked/10 px-3 py-2 text-sm font-medium text-status-blocked"
              >
                <Archive className="h-4 w-4" />
                Archive
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FeedbackWorkspace({
  scenario,
  activeTab,
  onTabChange,
}: {
  scenario: Scenario;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
}) {
  const tabs: RightTab[] = scenario.reviewHistory
    ? ["feedback", "pins", "media"]
    : ["pins", "media"];

  const unresolvedCount = scenario.reviewers.reduce(
    (sum, reviewer) => sum + reviewer.unresolved,
    0
  );
  const totalReviewers = scenario.reviewers.length;

  return (
    <div className="flex h-full min-h-[620px] flex-col rounded-2xl border border-border/70 bg-card/85 shadow-sm backdrop-blur-sm">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-2">
          {tabs.map((tab) => {
            const isActive = activeTab === tab;
            const count =
              tab === "feedback" && scenario.reviewHistory
                ? unresolvedCount
                : 0;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => onTabChange(tab)}
                className={cn(
                  "rounded-xl px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                {tab === "feedback"
                  ? "Feedback"
                  : tab === "pins"
                    ? "Pins"
                    : "Media"}
                {count > 0 ? ` ${count}` : ""}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "feedback" && scenario.reviewHistory ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border/70 bg-background/35 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatPill
                  icon={MessageSquareText}
                  label={`${unresolvedCount} unresolved`}
                  tone={unresolvedCount > 0 ? "alert" : "positive"}
                />
                <StatPill
                  icon={Sparkles}
                  label={`${totalReviewers} reviewer${totalReviewers === 1 ? "" : "s"}`}
                />
                <StatPill icon={CheckCheck} label="Approved" tone="positive" />
              </div>
            </div>

            {scenario.reviewers.map((reviewer) => (
              <div
                key={reviewer.id}
                className="rounded-2xl border border-border/70 bg-background/35 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {reviewer.name}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {reviewer.verdict === "reviewing"
                        ? "Reviewing"
                        : reviewer.verdict === "approve"
                          ? "Approved"
                          : "Changes requested"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground"
                    >
                      Summary
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground"
                    >
                      <Terminal className="mr-1 inline h-3.5 w-3.5" />
                      Terminal
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground"
                    >
                      Auto-triage
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {reviewer.feedback
                    .filter((item) => item.status === "open")
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-left"
                      >
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            feedbackDot[item.severity]
                          )}
                        />
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {item.file}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {item.title}
                        </span>
                      </button>
                    ))}
                </div>

                {reviewer.resolved > 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    Show {reviewer.resolved} resolved
                  </div>
                ) : null}
              </div>
            ))}

            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    Feedback detail
                  </div>
                  <div className="text-xs text-muted-foreground">
                    This remains the focused action area for WDYT, Fix, and
                    status changes.
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">1 / 2</div>
              </div>
              <div className="space-y-3">
                <div>
                  <Label>Description</Label>
                  <div className="mt-1 text-sm text-foreground">
                    Pending web notification state can linger after reconnect
                    and keep the UI summary row stale.
                  </div>
                </div>
                <div>
                  <Label>Suggestion</Label>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Reset pending notification state after a successful ack and
                    force the summary cache to re-read the newest SSE event.
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
                  <RowAction active>WDYT</RowAction>
                  <RowAction>Fix</RowAction>
                  <div className="ml-auto flex gap-2">
                    <RowAction>Fixed</RowAction>
                    <RowAction>Ignore</RowAction>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "pins" ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Pin className="h-4 w-4 text-primary" />
                Pins stay lightweight and copy-friendly
              </div>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/70 px-3 py-2">
                  <span className="text-muted-foreground">Validation Web</span>
                  <span className="font-mono text-foreground">
                    127.0.0.1:64233
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/70 px-3 py-2">
                  <span className="text-muted-foreground">Cleanup</span>
                  <span className="font-mono text-foreground">
                    dispatch-dev down
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "media" ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <PanelRight className="h-4 w-4 text-primary" />
                Media remains adjacent to prototypes and review artifacts
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {[
                  "feedback-empty-state.png",
                  "review-summary-wireframe.png",
                  "mobile-feedback-sheet.png",
                ].map((asset) => (
                  <div
                    key={asset}
                    className="rounded-2xl border border-border/70 bg-card/70 p-3"
                  >
                    <div className="aspect-[4/3] rounded-xl border border-dashed border-border/70 bg-background/30" />
                    <div className="mt-2 text-xs text-muted-foreground">
                      {asset}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DesktopPreview({
  scenario,
  expanded,
  activeTab,
  onTabChange,
}: {
  scenario: Scenario;
  expanded: boolean;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[28px] border border-border/80 bg-background shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between border-b border-border/70 bg-card/50 px-5 py-3">
        <div className="flex items-center gap-3 text-sm">
          <div className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
            /design-lab
          </div>
          <span className="text-muted-foreground">Prototype Playground</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Feedback tab becomes first tab after review exists
        </div>
      </div>
      <div className="grid min-h-[720px] grid-cols-[360px_minmax(0,1fr)_420px] bg-surface">
        <div className="border-r border-border/70 p-4">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
            <FolderGit2 className="h-4 w-4 text-primary" />
            Agents
          </div>
          <AgentSummaryCard scenario={scenario} expanded={expanded} />
        </div>
        <div className="border-r border-border/70 bg-background/45 p-6">
          <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Terminal className="h-4 w-4 text-primary" />
              Main workspace stays focused on the connected agent
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/35 p-5 text-sm text-muted-foreground">
              The redesign keeps the left card concise, moves reviewer workflow
              into the right pane, and lets this central area remain the primary
              coding workspace.
            </div>
          </div>
        </div>
        <div className="p-4">
          <FeedbackWorkspace
            scenario={scenario}
            activeTab={activeTab}
            onTabChange={onTabChange}
          />
        </div>
      </div>
    </div>
  );
}

function MobilePreview({
  scenario,
  activeTab,
  onTabChange,
}: {
  scenario: Scenario;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
}) {
  const canShowFeedback = scenario.reviewHistory;
  return (
    <div className="mx-auto max-w-[390px] overflow-hidden rounded-[32px] border border-border/80 bg-background shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="text-sm font-semibold text-foreground">Dispatch</div>
        <div className="text-xs text-muted-foreground">Mobile prototype</div>
      </div>
      <div className="p-4">
        <AgentSummaryCard scenario={scenario} expanded={false} />
      </div>
      {canShowFeedback ? (
        <div className="border-t border-border/70 bg-card/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-foreground">
              Feedback
            </div>
            <div className="text-xs text-muted-foreground">
              Tapping the summary row jumps here directly
            </div>
          </div>
          <div className="mb-3 flex items-center gap-2">
            {(["feedback", "pins", "media"] as RightTab[]).map((tab) => (
              <RowAction
                key={tab}
                active={activeTab === tab}
                onClick={() => onTabChange(tab)}
              >
                {tab === "feedback"
                  ? "Feedback"
                  : tab === "pins"
                    ? "Pins"
                    : "Media"}
              </RowAction>
            ))}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <FeedbackWorkspace
              scenario={scenario}
              activeTab={activeTab}
              onTabChange={onTabChange}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DesignLabPrototypePlayground(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [scenarioId, setScenarioId] = useState<ScenarioId>("review-unresolved");
  const [expanded, setExpanded] = useState(true);
  const scenario = useMemo(
    () =>
      prototypeScenarios.find((item) => item.id === scenarioId) ??
      prototypeScenarios[0],
    [scenarioId]
  );

  const defaultTab: RightTab = scenario.reviewHistory ? "feedback" : "pins";
  const [activeTab, setActiveTab] = useState<RightTab>(defaultTab);

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-border/70 bg-card/70 p-6 backdrop-blur-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.16em] text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Prototype Playground
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
              A reusable lab for mock data, rapid UI states, and theme checks
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This mode is meant to be an agent-friendly playground. Prototypes
              can live here with mocked states, explicit controls, and a
              built-in way to verify layout decisions across themes and viewport
              presets.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:w-[520px]">
            <StatPill icon={MoonStar} label="Theme switcher" />
            <StatPill icon={Monitor} label="Viewport presets" />
            <StatPill icon={MessageSquareText} label="Mock scenarios" />
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[220px_220px_1fr]">
          <div className="space-y-2">
            <Label>Theme</Label>
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
            <Label>Scenario</Label>
            <Select
              value={scenarioId}
              onValueChange={(value) => setScenarioId(value as ScenarioId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Scenario" />
              </SelectTrigger>
              <SelectContent>
                {prototypeScenarios.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Canvas controls</Label>
            <div className="flex flex-wrap gap-2">
              <RowAction
                active={viewport === "desktop"}
                onClick={() => setViewport("desktop")}
              >
                <Monitor className="mr-1.5 inline h-3.5 w-3.5" />
                Desktop
              </RowAction>
              <RowAction
                active={viewport === "mobile"}
                onClick={() => setViewport("mobile")}
              >
                <Smartphone className="mr-1.5 inline h-3.5 w-3.5" />
                Mobile
              </RowAction>
              <RowAction
                active={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Expanded card" : "Collapsed card"}
              </RowAction>
              <RowAction
                active={activeTab === defaultTab}
                onClick={() => setActiveTab(defaultTab)}
              >
                Reset default tab
              </RowAction>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-border/70 bg-background/40 p-4">
          <div className="text-sm font-medium text-foreground">
            {scenario.label}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {scenario.description}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-border/70 bg-surface/80 p-4 lg:p-6">
        {viewport === "desktop" ? (
          <DesktopPreview
            scenario={scenario}
            expanded={expanded}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        ) : (
          <MobilePreview
            scenario={scenario}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-border/70 bg-card/70 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <PanelRight className="h-4 w-4 text-primary" />
            Agent-detail direction
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            Left card handles scan and triage. Expanded state holds overview,
            review entry points, and context. Feedback becomes a dedicated
            workspace in the right pane.
          </div>
        </div>
        <div className="rounded-2xl border border-border/70 bg-card/70 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MoonStar className="h-4 w-4 text-primary" />
            Prototype tooling
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            Theme switching is inline so UI prototypes can be validated across
            the app’s existing theme matrix without leaving the mock surface.
          </div>
        </div>
        <div className="rounded-2xl border border-border/70 bg-card/70 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Future additions
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            This foundation can grow into reusable fixtures, viewport presets,
            interaction notes, token inspectors, and exportable mock scenarios.
          </div>
        </div>
      </div>
    </div>
  );
}
