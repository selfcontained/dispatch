import {
  Archive,
  ClipboardCheck,
  ClipboardList,
  Eye,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Terminal,
  Unplug,
} from "lucide-react";
import type { ReactNode } from "react";

import { describeAgentStatus } from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { TipSpot } from "@/components/tips/tip-spot";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Wraps the REVIEW badge in the "open review from the menu" tip once its
 * review is ready to open — otherwise renders the badge plain. A tiny local
 * component (rather than an inline ternary) so TipSpot's own eligibility
 * check still only ever mounts for a badge that's actually ready.
 */
function ReviewBadge({
  tip,
  children,
}: {
  tip: boolean;
  children: ReactNode;
}): JSX.Element {
  if (!tip) return <>{children}</>;
  return (
    <TipSpot tipId="review-row-open" side="bottom" align="center">
      {children}
    </TipSpot>
  );
}

export type ChildAgentRowProps = {
  agent: Agent;
  state: AgentVisualState;
  isInitialReviewActive: boolean;
  attachToAgent: (agent: Agent) => Promise<void>;
  detachTerminal: () => void;
  startAgent: (agent: Agent) => Promise<void>;
  openSubmittedReview: (agent: Agent) => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
  onEditSettings: (agent: Agent) => void;
  onRequestClose?: () => void;
  closeOnSessionAction?: boolean;
};

export function ChildAgentRow({
  agent,
  state,
  isInitialReviewActive,
  attachToAgent,
  detachTerminal,
  startAgent,
  openSubmittedReview,
  setStopTarget,
  setStopConfirmOpen,
  setDeleteTarget,
  setDeleteConfirmOpen,
  onEditSettings,
  onRequestClose,
  closeOnSessionAction = false,
}: ChildAgentRowProps): JSX.Element {
  const isStopped = state === "stopped";
  // Not the raw isConnected/connectedAgentId-equality prop: that stays true
  // through a mid-reconnect or a dropped socket, which would make a click
  // silently detach a row that visually reads as "not connected" (its
  // accent already follows this same condition, below). state === "active"
  // is what use-agents.ts's agentVisualState actually calls "connected."
  const isConnectedActive = state === "active";
  const isArchiving = agent.status === "archiving";
  // The shared DropdownMenuItem is a plain block styled for destructive items;
  // these need inline icons and the normal foreground colour.
  const menuItemClass =
    "flex min-h-11 items-center gap-2 text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 sm:min-h-0";
  const isReviewAgent = agent.role === "review";
  const canOpenSubmittedReview =
    isReviewAgent && agent.submittedReviewId != null;
  const showReviewActivity =
    isReviewAgent && agent.status === "running" && isInitialReviewActive;
  // canOpenSubmittedReview is just "no submission yet" — much broader than
  // "actively working," so a paused or errored reviewer needs its own
  // wording rather than a blanket "Review in progress."
  const reviewPendingLabel =
    agent.status === "error"
      ? "Review agent — no review submitted"
      : isStopped
        ? "Review agent — paused, no review submitted"
        : "Review in progress";
  const displayName = agent.persona ?? agent.name;
  const { label: statusLabel, colorClass: statusColor } = describeAgentStatus(
    agent,
    isStopped
  );

  const row = (
    <div
      data-testid={`child-agent-row-${agent.id}`}
      data-agent-role={agent.role ?? "standard"}
      data-review-active={showReviewActivity ? "true" : "false"}
      data-review-ready={canOpenSubmittedReview ? "true" : "false"}
      onClick={(event) => {
        // Mirrors the top-level agent card's row-click-to-attach/detach
        // (agent-card-header.tsx): a data-agent-control="true" marker plus
        // closest() lets interactive descendants (the overflow menu, the
        // resume button) opt out of the row's own click, the same
        // convention that file uses instead of stopPropagation. Opening a
        // submitted review is a separate action, reached through the
        // overflow menu and the badge below — not tied to this click at
        // all, so there's no race between the two actions' navigation.
        const target = event.target as HTMLElement;
        // Radix (DropdownMenuContent, TipSpot's Popover, Tooltip content)
        // portals its content to document.body — outside this row's real
        // DOM subtree — but React's synthetic events still bubble through
        // the *component* tree regardless of where they're portaled to.
        // contains() walks the real DOM, so this is the one check that
        // actually catches every portal, not just the ones marked below.
        if (!event.currentTarget.contains(target)) return;
        if (target.closest("[data-agent-control='true']")) return;
        if (isStopped) return;
        if (isConnectedActive) {
          detachTerminal();
          return;
        }
        if (closeOnSessionAction) onRequestClose?.();
        void attachToAgent(agent);
      }}
      className={cn(
        // Rounded on every corner, like an ordinary pill, with a normal
        // matching 1px border on all four sides at rest — no permanently
        // reserved thick edge (that read as either a muted "always-there"
        // border, or, fully transparent, as no border at all on one side).
        // Only the connected row below adds border-r-4 on top of this, so
        // "thick right edge" exclusively means "this one's connected," and
        // every other row just looks like an ordinary bordered pill.
        "group relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/30 px-2 py-1 sm:py-1.5",
        "transition-colors hover:bg-muted/35",
        !isStopped && "cursor-pointer",
        // Connected row: the same solid right-edge border treatment the
        // top-level agent card uses for "this is what's connected"
        // (agents-view.tsx's borderForAgentState), so the signal reads
        // consistently across both list levels — and, being the only state
        // that thickens this edge at all, exclusively means "connected." A
        // ready-to-open review no longer has its own border treatment at
        // all (that signal now lives on the review indicator's icon/color
        // swap below), so it can't compete with or dilute this one. state ===
        // "active" (not the bare isConnected prop) so this exactly matches
        // the top-level card's own condition (use-agents.ts's
        // agentVisualState: running/creating AND actually connected).
        state === "active" && "border-r-4 border-r-status-done",
        isStopped && "opacity-65",
        canOpenSubmittedReview && "opacity-100",
        showReviewActivity && "child-agent-review-active-row"
      )}
    >
      <AgentTypeIcon
        type={agent.type}
        eventType={
          agent.status === "running" ? agent.latestEvent?.type : undefined
        }
        className="h-4.5 w-4.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 truncate text-[11px] font-medium"
            title={agent.name}
          >
            {displayName}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center text-[10px]">
          <span className={cn("font-medium", statusColor)}>{statusLabel}</span>
          {agent.latestEvent?.updatedAt ? (
            <>
              <span className="mx-1 text-muted-foreground/50">•</span>
              <span className="truncate text-muted-foreground/70">
                {formatRelativeTime(agent.latestEvent.updatedAt)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {/*
        Right-side action cluster: REVIEW badge, resume button (stopped
        agents only), overflow menu. Grouped in one shrink-0 flex container
        (rather than the badge living inside the shrinking label) so the
        label is the only thing that gives way to a long name — this
        cluster never competes with it for space. Plain elements here (no
        pointer-events tricks needed): a click anywhere in the cluster that
        isn't a real control just bubbles up to the row's own onClick, same
        as clicking blank space anywhere else in the row.
      */}
      <div className="flex shrink-0 items-center gap-1">
        {isReviewAgent ? (
          <ReviewBadge tip={canOpenSubmittedReview}>
            {canOpenSubmittedReview ? (
              // A real button, not inert decoration: it's the one element
              // in the row that visibly lights up (a filled clipboard-check
              // in the "done" green, distinct from the connected accent's
              // blue so the two signals never compete), so it's also the
              // thing a user is most likely to click or tap aiming to open
              // the review — including on a stopped row, whose
              // click-to-connect is otherwise a dead end. Its own trigger
              // (not the row's) so it can't race attachToAgent's navigate
              // the way a combined click used to.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost-primary"
                    data-agent-control="true"
                    data-testid={`child-agent-open-review-badge-${agent.id}`}
                    aria-label={`Open submitted review from ${displayName}`}
                    onClick={() => {
                      if (closeOnSessionAction) onRequestClose?.();
                      openSubmittedReview(agent);
                    }}
                    className="h-11 w-11 sm:h-7 sm:w-7"
                  >
                    <ClipboardCheck
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open submitted review</TooltipContent>
              </Tooltip>
            ) : (
              // Decorative only — the row's own status line already says
              // "Working"/etc.; this just marks the agent as a reviewer with
              // no submission yet. Label follows the same stopped/error
              // condition the status line uses, not a blanket "in progress"
              // that would misdescribe a paused or errored reviewer.
              <span
                role="img"
                aria-label={reviewPendingLabel}
                title={reviewPendingLabel}
                className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground sm:h-7 sm:w-7"
              >
                <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            )}
          </ReviewBadge>
        ) : null}
        {/*
          Attach/detach no longer have their own buttons — clicking
          anywhere on the row does it (mirrors the top-level agent card,
          see the row's onClick above). A stopped agent isn't click-to-
          attach, though (the row's onClick bails out via isStopped), so
          it keeps a dedicated Resume control, same as the top-level card.
        */}
        {isStopped ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost-primary"
                data-agent-control="true"
                data-testid={`child-agent-resume-${agent.id}`}
                aria-label={`Resume ${displayName}`}
                className="h-11 w-11 sm:h-7 sm:w-7"
                onClick={() => {
                  if (closeOnSessionAction) onRequestClose?.();
                  void startAgent(agent);
                }}
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Resume child agent</TooltipContent>
          </Tooltip>
        ) : null}
        {/*
          Session lifecycle controls. A sub agent used to offer only terminal
          attach and resume, so moving plain children into this section would
          have stripped the pause/rename/archive an agent card carries in its
          footer. They live behind an overflow menu because the row has one
          action slot.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              data-agent-control="true"
              data-testid={`child-agent-menu-${agent.id}`}
              aria-label={`Session actions for ${displayName}`}
              className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          {/*
            data-agent-control marks the whole content, not just the
            trigger button: Radix portals this out of the row's DOM
            subtree, so it's not a real ancestor of an item's click target
            in the row's own onClick's closest() check. The row's own
            currentTarget.contains() guard already catches this (and every
            other portal, e.g. the tip popover) on its own — this stays as
            a second, belt-and-braces guard.
          */}
          <DropdownMenuContent align="end" data-agent-control="true">
            {!isStopped ? (
              // The keyboard/screen-reader path to connect — the row's own
              // click-to-attach has no non-mouse equivalent, so this is the
              // only accessible way to reach a sub agent's terminal. Label
              // and action both follow isConnectedActive, matching what the
              // row's own accent and click already mean by "connected."
              <DropdownMenuItem
                className={menuItemClass}
                data-testid={`child-agent-terminal-${agent.id}`}
                onSelect={() => {
                  if (isConnectedActive) {
                    detachTerminal();
                    return;
                  }
                  if (closeOnSessionAction) onRequestClose?.();
                  void attachToAgent(agent);
                }}
              >
                {isConnectedActive ? (
                  <Unplug className="h-3.5 w-3.5" />
                ) : (
                  <Terminal className="h-3.5 w-3.5" />
                )}
                {isConnectedActive ? "Detach" : "View terminal"}
              </DropdownMenuItem>
            ) : null}
            {canOpenSubmittedReview ? (
              <DropdownMenuItem
                className={menuItemClass}
                data-testid={`child-agent-open-review-${agent.id}`}
                onSelect={() => {
                  if (closeOnSessionAction) onRequestClose?.();
                  openSubmittedReview(agent);
                }}
              >
                <Eye className="h-3.5 w-3.5" />
                Open review
              </DropdownMenuItem>
            ) : null}
            {!isStopped && !isArchiving ? (
              <DropdownMenuItem
                className={menuItemClass}
                data-testid={`child-agent-pause-${agent.id}`}
                onSelect={() => {
                  setStopTarget(agent);
                  setStopConfirmOpen(true);
                }}
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </DropdownMenuItem>
            ) : null}
            {isStopped && !isArchiving ? (
              <DropdownMenuItem
                className={menuItemClass}
                data-testid={`child-agent-menu-resume-${agent.id}`}
                onSelect={() => {
                  if (closeOnSessionAction) onRequestClose?.();
                  void startAgent(agent);
                }}
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className={menuItemClass}
              data-testid={`child-agent-settings-${agent.id}`}
              onSelect={() => onEditSettings(agent)}
            >
              <Pencil className="h-3.5 w-3.5" />
              Session details
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex min-h-11 items-center gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 sm:min-h-0"
              data-testid={`child-agent-archive-${agent.id}`}
              disabled={isArchiving || agent.status === "creating"}
              onSelect={() => {
                setDeleteTarget(agent);
                setDeleteConfirmOpen(true);
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return row;
}
