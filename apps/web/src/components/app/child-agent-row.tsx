import {
  Archive,
  Check,
  Eye,
  MoreVertical,
  Pause,
  Pencil,
  Play,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { TipSpot } from "@/components/tips/tip-spot";
import { Badge } from "@/components/ui/badge";
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
  isConnected: boolean;
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
  isConnected,
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
  const displayName = agent.persona ?? agent.name;
  const statusLabel = isStopped
    ? "Stopped"
    : agent.status === "error"
      ? "Error"
      : agent.latestEvent
        ? latestEventLabel(agent.latestEvent.type)
        : "Running";
  const statusColor =
    agent.status === "error"
      ? "text-status-blocked"
      : agent.latestEvent && !isStopped
        ? latestEventColor(agent.latestEvent.type)
        : "text-muted-foreground";

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
        // overflow menu below — not tied to this click at all, so there's
        // no race between the two actions' navigation.
        const target = event.target as HTMLElement;
        if (target.closest("[data-agent-control='true']")) return;
        if (isStopped) return;
        if (isConnected) {
          detachTerminal();
          return;
        }
        if (closeOnSessionAction) onRequestClose?.();
        void attachToAgent(agent);
      }}
      className={cn(
        // No rounded corners at all (a single rounded side read as odd):
        // the connected accent below is meant to read as one continuous
        // bar, uninterrupted by any corner treatment, echoing the
        // top-level card's own border-r-4 treatment. border-r-4 is in the
        // BASE, unconditionally, and every row's right edge is always
        // painted some color (never literally transparent) — so every
        // row's border closes into a complete shape instead of reading as
        // cut open on one side, and every row keeps identical internal
        // geometry (a row whose border-r width varied by state measurably
        // misaligned its controls against its neighbors).
        "group relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-none border border-border/60 border-r-4 border-r-border/60 bg-background/30 px-2 py-1 sm:py-1.5",
        "transition-colors hover:bg-muted/35",
        !isStopped && "cursor-pointer",
        // Connected row: the same solid right-edge border treatment the
        // top-level agent card uses for "this is what's connected"
        // (agents-view.tsx's borderForAgentState), so the signal reads
        // consistently across both list levels — and, being the only state
        // that colors just the right edge differently from the row's other
        // three sides, exclusively means "connected." A ready-to-open
        // review no longer has its own border treatment at all (that
        // signal now lives on the REVIEW badge's checkmark below), so it
        // can't compete with or dilute this one. state === "active" (not
        // the bare isConnected prop) so this exactly matches the
        // top-level card's own condition (use-agents.ts's
        // agentVisualState: running/creating AND actually connected).
        // isConnected alone would keep the accent lit for a
        // paused-but-still-attached agent, or after the terminal socket
        // drops — both cases where the top-level card already goes
        // transparent, so the two would disagree about the same fact.
        state === "active" && "border-r-status-done",
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
            <Badge
              className={cn(
                "h-4 gap-0.5 border-primary px-1 text-[8px] font-semibold uppercase tracking-wide",
                canOpenSubmittedReview
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-foreground"
              )}
            >
              {/* The checkmark carries "ready to open" directly on the
                  badge instead of a row-wide border treatment, which used
                  to look like a muted version of the connected accent. */}
              {canOpenSubmittedReview ? (
                <Check className="h-2.5 w-2.5" aria-hidden="true" />
              ) : null}
              Review
            </Badge>
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
            subtree, but React's synthetic events still bubble through the
            *component* tree, so a click inside would otherwise also reach
            the row's own onClick above. target.closest() here walks the
            real (portaled) DOM, where this attribute is an actual ancestor
            of every item's click target.
          */}
          <DropdownMenuContent align="end" data-agent-control="true">
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
              Session settings
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
