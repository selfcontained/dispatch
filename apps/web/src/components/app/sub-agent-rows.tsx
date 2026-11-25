/**
 * Sub agents as rows in the expanded card's details panel, on the panel's
 * icon column. Collapsed, the panel shows the count, the first sub agent
 * with a running step (the same pick as the collapsed card's activity line)
 * and the review totals; expanding grows the same rows in place beneath it.
 * A row opens that sub agent's stream.
 */
import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  Clipboard,
  Play,
  ClipboardCheck,
  ClipboardList,
  Users,
} from "lucide-react";

import { AgentActivityLabel } from "@/components/app/agent-activity";
import {
  AgentActionsMenu,
  type AgentActionsProps,
} from "@/components/app/agent-card-actions";
import {
  AgentCardPhaseStatus,
  hasPhaseStatus,
} from "@/components/app/agent-card-status";
import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import { ChatUnreadBadge } from "@/components/app/chat/chat-unread-badge";
import { type Agent } from "@/components/app/types";
import type { AgentReviewSummary } from "@dispatch/shared";
import { IconButton } from "@/components/ui/icon-button";
import { RowButton } from "@/components/ui/row-button";
import { agentRoute, THREAD_PARAM } from "@/lib/agent-routes";
import { useAgentReviewSummary } from "@/hooks/use-agent-review-summary";
import { useFirstAgentWithTurnLabel } from "@/hooks/use-agent-turn-label";
import { cn } from "@/lib/utils";

type ReviewEntry = AgentReviewSummary["agents"][string];

/** A review whose reviewer has been archived: kept, but not a sub agent. */
type ArchivedReview = ReviewEntry & { agentId: string };

/**
 * Reviews of `parentId`'s work whose reviewers have since been archived.
 * The review summary outlives the agent list, which drops archived agents.
 */
function archivedReviewsOf(
  parentId: string | undefined,
  childAgents: Agent[],
  reviews: ReturnType<typeof useAgentReviewSummary>["data"]
): ArchivedReview[] {
  if (!parentId) return [];
  const live = new Set(childAgents.map((c) => c.id));
  return Object.entries(reviews?.agents ?? {})
    .filter(
      ([id, review]) =>
        review.archived && review.toAgentId === parentId && !live.has(id)
    )
    .map(([agentId, review]) => ({ ...review, agentId }))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        a.agentId.localeCompare(b.agentId)
    );
}

/** Review totals across the sub agents that review, and archived reviewers. */
function reviewTotals(
  childAgents: Agent[],
  reviews: ReturnType<typeof useAgentReviewSummary>["data"],
  archived: ArchivedReview[]
) {
  const reviewers = childAgents.filter(
    (c) => reviews?.agents?.[c.id] || c.role === "review"
  );
  if (!reviewers.length && !archived.length) return null;
  let open = 0;
  let done = 0;
  let running = 0;
  for (const r of reviewers) {
    const s = reviews?.agents?.[r.id];
    if (!s) {
      if (r.status === "running") running += 1;
      continue;
    }
    open += s.openFindings;
    if (s.status === "resolved") done += 1;
  }
  for (const s of archived) {
    open += s.openFindings;
    if (s.status === "resolved") done += 1;
  }
  return { total: reviewers.length + archived.length, open, done, running };
}

/** A clean review raised nothing; a resolved one had findings, all settled. */
function resolvedLabel(review: { findingCount?: number }): string {
  return review.findingCount === 0 ? "Clean review" : "Review resolved";
}

const ROW_GRID = "grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3";

export function SubAgentRows({
  parentId,
  childAgents,
  seats,
  onOpenAgent,
  onNavigate,
  viewingId,
  actions,
}: {
  /** The agent whose card this is; its archived reviewers' reviews stay. */
  parentId?: string;
  childAgents: Agent[];
  seats: Record<string, number>;
  onOpenAgent: (agent: Agent) => void;
  onNavigate?: () => void;
  /** The sub agent whose stream is open, if any. */
  viewingId?: string | null;
  actions: SubAgentActions;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const reviews = useAgentReviewSummary();
  const firstActive = useFirstAgentWithTurnLabel(
    childAgents.filter((child) => child.currentTurn)
  );
  const archived = archivedReviewsOf(parentId, childAgents, reviews.data);
  if (childAgents.length === 0 && archived.length === 0) return null;
  const isReviewer = (c: Agent) =>
    Boolean(reviews.data?.agents?.[c.id]) || c.role === "review";
  const isLive = (c: Agent) => Boolean(c.currentTurn) && c.status === "running";
  const working = childAgents.filter((c) => isLive(c) && !isReviewer(c));
  const reviewers = childAgents.filter(isReviewer);
  const rest = childAgents.filter(
    (c) => !working.includes(c) && !reviewers.includes(c)
  );
  const ordered = [...working, ...reviewers, ...rest];
  // Collapsed: the same pick as the collapsed card's activity line — the
  // first sub agent with a running step to show.
  const shown = expanded ? ordered : firstActive ? [firstActive] : [];
  const hiddenWorking = childAgents.filter(
    (c) => isLive(c) && !shown.includes(c)
  ).length;
  const review = reviewTotals(childAgents, reviews.data, archived);
  const liveCount = childAgents.filter(isLive).length;

  return (
    <div className="flex flex-col" data-testid="sub-agent-rows">
      <RowButton
        className={cn(
          ROW_GRID,
          "-mx-1.5 min-h-7 w-[calc(100%+0.75rem)] rounded-md px-1.5 text-left text-label-sm pointer-coarse:min-h-9"
        )}
        data-agent-control="true"
        data-testid="sub-agents-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <Users aria-hidden="true" className="size-icon-md text-faint" />
        <span className="flex min-w-0 items-baseline gap-1.5 truncate">
          {childAgents.length ? (
            <>
              <span className="text-foreground">
                {childAgents.length} sub agent
                {childAgents.length === 1 ? "" : "s"}
              </span>
              {liveCount ? (
                <span className="text-status-working">
                  · {liveCount} working
                </span>
              ) : (
                <span className="text-faint">· idle</span>
              )}
            </>
          ) : null}
          {archived.length ? (
            <span
              className={childAgents.length ? "text-faint" : "text-foreground"}
            >
              {childAgents.length ? "· " : ""}
              {archived.length} archived reviewer
              {archived.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-icon-md text-faint transition-transform",
            expanded && "rotate-180"
          )}
        />
      </RowButton>
      <div className="flex flex-col">
        <AnimatePresence initial={false}>
          {shown.map((c) => (
            <motion.div
              key={c.id}
              layout="position"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="-mx-1.5 overflow-hidden"
            >
              <SubAgentRow
                agent={c}
                seat={seats[c.id] ?? null}
                review={reviews.data?.agents?.[c.id]}
                reviewer={isReviewer(c)}
                viewing={c.id === viewingId}
                actions={actions}
                onNavigate={onNavigate}
                onOpen={() => {
                  onNavigate?.();
                  onOpenAgent(c);
                }}
              />
            </motion.div>
          ))}
          {expanded
            ? archived.map((r) => (
                <motion.div
                  key={r.agentId}
                  layout="position"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="-mx-1.5 overflow-hidden"
                >
                  <ArchivedReviewRow review={r} onNavigate={onNavigate} />
                </motion.div>
              ))
            : null}
        </AnimatePresence>
        {!expanded && hiddenWorking > 0 ? (
          <RowButton
            dense
            data-agent-control="true"
            onClick={() => setExpanded(true)}
            className={cn(
              ROW_GRID,
              "min-h-6 text-label-xs text-faint hover:text-foreground"
            )}
          >
            <span />
            <span>+ {hiddenWorking} more working</span>
            <span />
          </RowButton>
        ) : null}
      </div>
      {review ? (
        <div className={cn(ROW_GRID, "mt-1 min-h-7 text-label-sm")}>
          <ClipboardCheck
            aria-hidden="true"
            className="size-icon-md text-faint"
          />
          <span className="text-foreground">Reviews</span>
          <span className="flex items-center gap-1.5">
            {review.running ? (
              <ReviewChip
                tone="running"
                count={review.running}
                label={`${review.running} reviewing`}
              />
            ) : null}
            {review.open ? (
              <ReviewChip
                tone="open"
                count={review.open}
                label={`${review.open} open findings`}
              />
            ) : null}
            {review.done ? (
              <ReviewChip
                tone="done"
                count={review.done}
                label={`${review.done} resolved`}
              />
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Review state as one icon + colour + count: clipboard-list (red) with the
 * open-finding count, clipboard-check (green) when resolved, a plain
 * clipboard with the light chaser while the review is still running.
 */
function ReviewChip({
  tone,
  count,
  label,
}: {
  tone: "open" | "done" | "running";
  count?: number;
  label: string;
}) {
  const Icon =
    tone === "open"
      ? ClipboardList
      : tone === "done"
        ? ClipboardCheck
        : Clipboard;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "relative inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-label-xs tabular-nums",
        tone === "open" && "bg-danger/tint text-danger",
        tone === "done" && "bg-success/tint text-success",
        tone === "running" &&
          "review-chase-ring bg-surface-subtle text-muted-foreground"
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {count !== undefined ? <span>{count}</span> : null}
    </span>
  );
}

/**
 * A review left by a reviewer that has since been archived: who reviewed,
 * how it stands, and the review itself one click away at the reviewer's
 * home, where its findings and their threads stay.
 */
function ArchivedReviewRow({
  review,
  onNavigate,
}: {
  review: ArchivedReview;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  // The name, not the persona: two reviewers can share a persona.
  const name = review.name;
  return (
    <RowButton
      className={cn(
        ROW_GRID,
        "min-h-8 w-full rounded-md px-1.5 py-1 text-left text-label-sm hover:bg-surface-hover"
      )}
      aria-label={`Open review by ${name} (archived)`}
      data-agent-control="true"
      data-testid={`archived-review-${review.agentId}`}
      onClick={() => {
        onNavigate?.();
        navigate({
          pathname: agentRoute(review.streamId),
          search: `?${new URLSearchParams({ [THREAD_PARAM]: review.threadId })}`,
        });
      }}
    >
      <span className="flex justify-center">
        <Archive aria-hidden="true" className="size-icon-md text-faint" />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className="min-w-0 truncate text-foreground"
          title={review.persona ?? undefined}
        >
          {name}
        </span>
        <span className="shrink-0 text-faint">archived</span>
      </span>
      {review.openFindings ? (
        <ReviewChip
          tone="open"
          count={review.openFindings}
          label={`${review.openFindings} open findings`}
        />
      ) : (
        <ReviewChip tone="done" label={resolvedLabel(review)} />
      )}
    </RowButton>
  );
}

/** What a sub agent's ⋯ menu acts with; the card owns the dialogs. */
export type SubAgentActions = Pick<
  AgentActionsProps,
  "enabledAgentTypes" | "enabledIdes"
> & {
  cascadeCount: (agent: Agent) => number;
  onPause: (agent: Agent) => void;
  onResume: (agent: Agent) => void;
  onArchive: (agent: Agent) => void;
  onShowDetails: (agent: Agent) => void;
  onChangeWorkspace: (agent: Agent) => void;
};

/**
 * One sub agent: seat on the icon column, name, state, then its ⋯ menu last;
 * the live step (or setup progress) beneath. The row opens its stream.
 */
function SubAgentRow({
  agent,
  seat,
  review,
  reviewer,
  viewing,
  onOpen,
  actions,
  onNavigate,
}: {
  agent: Agent;
  seat: number | null;
  review?: {
    status: string;
    openFindings: number;
    findingCount?: number;
    streamId: string;
    threadId: string;
  };
  reviewer: boolean;
  viewing: boolean;
  onOpen: () => void;
  actions: SubAgentActions;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const live = Boolean(agent.currentTurn) && agent.status === "running";
  const isStopped = agent.status !== "running" && agent.status !== "creating";
  const archiving = agent.status === "archiving";
  const name = reviewer ? (agent.persona ?? agent.name) : agent.name;
  const reviewing = reviewer && !review && agent.status === "running";
  const resume = () => {
    onNavigate?.();
    actions.onResume(agent);
  };
  const phase = hasPhaseStatus(agent);
  return (
    <div
      className={cn(
        "relative flex items-start rounded-md transition-colors",
        viewing ? "bg-surface-selected" : "hover:bg-surface-hover",
        isStopped && "opacity-65"
      )}
      data-testid={`sub-agent-${agent.id}`}
    >
      <RowButton
        className="flex min-w-0 flex-1 flex-col items-stretch gap-0.5 bg-transparent px-1.5 py-1 hover:bg-transparent"
        aria-current={viewing ? "page" : undefined}
        aria-label={`Open ${name}`}
        data-agent-control="true"
        data-testid={`sub-agent-row-${agent.id}`}
        onClick={onOpen}
      >
        <span className={cn(ROW_GRID, "min-h-6 text-label-sm")}>
          <span className="flex justify-center">
            <AgentSeatBadge
              seat={seat}
              name={name}
              type={agent.type}
              size="sm"
              data-testid={`sub-agent-avatar-${agent.id}`}
            />
          </span>
          <span className="min-w-0 truncate text-foreground">{name}</span>
          {review ? (
            review.openFindings ? (
              <ReviewChip
                tone="open"
                count={review.openFindings}
                label={`${review.openFindings} open findings`}
              />
            ) : (
              <ReviewChip tone="done" label={resolvedLabel(review)} />
            )
          ) : reviewing ? (
            <ReviewChip tone="running" label="Reviewing" />
          ) : isStopped && !archiving ? (
            <span className="text-faint">{agent.status}</span>
          ) : (
            <span />
          )}
        </span>
        {phase || live ? (
          <span className={cn(ROW_GRID, "min-w-0")}>
            <span />
            {phase ? (
              <AgentCardPhaseStatus
                agent={agent}
                className="mt-0 min-w-0 text-label-sm"
              />
            ) : (
              <AgentActivityLabel
                agent={agent}
                className="min-w-0 text-label-sm"
              />
            )}
            <span />
          </span>
        ) : null}
      </RowButton>
      <div className="flex min-h-8 shrink-0 items-center gap-0.5 pr-1">
        <ChatUnreadBadge agentId={agent.id} />
        {isStopped && !archiving ? (
          <IconButton
            size="icon-xs"
            tone="success"
            data-agent-control="true"
            data-testid={`sub-agent-resume-${agent.id}`}
            label={`Resume ${name}`}
            onClick={resume}
          >
            <Play />
          </IconButton>
        ) : null}
        <AgentActionsMenu
          variant="subagent"
          agent={agent}
          isStopped={isStopped}
          cascadeCount={actions.cascadeCount(agent)}
          enabledAgentTypes={actions.enabledAgentTypes}
          enabledIdes={actions.enabledIdes}
          onPause={() => actions.onPause(agent)}
          onResume={resume}
          onEditSettings={() => actions.onShowDetails(agent)}
          onChangeWorkspace={() => actions.onChangeWorkspace(agent)}
          onArchive={() => actions.onArchive(agent)}
          onOpenReview={
            review
              ? () => {
                  onNavigate?.();
                  navigate({
                    pathname: agentRoute(review.streamId),
                    search: `?${new URLSearchParams({ [THREAD_PARAM]: review.threadId })}`,
                  });
                }
              : undefined
          }
        />
      </div>
      {viewing ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1.5 right-0 w-[3px] rounded-full bg-status-done"
        />
      ) : null}
    </div>
  );
}
