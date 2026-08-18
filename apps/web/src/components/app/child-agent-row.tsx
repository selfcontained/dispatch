import {
  Archive,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Terminal,
  Unplug,
} from "lucide-react";

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
      className={cn(
        // Right corners stay square (a deliberate visual choice, not literal
        // edge-flushing — the row still sits inset inside the card's px-2,
        // the list's pr-2, etc.): the connected accent below is meant to
        // read as one continuous bar rather than one interrupted partway
        // through by a rounded corner, echoing the top-level card's own
        // border-r-4 treatment. border-r-4/border-r-transparent are in the
        // BASE, unconditionally — every row reserves the same 4px right
        // edge, so ready/connected/plain rows all keep identical internal
        // geometry (a ready row that instead fell back to a 1px border
        // measurably misaligned its controls against the rows above and
        // below it, and jumped 3px when a review's ready state flipped).
        "group relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-l-lg border border-border/60 border-r-4 border-r-transparent bg-background/30 px-2 py-1 sm:py-1.5",
        "transition-colors hover:bg-muted/35",
        // Ready-to-open wins over connected styling and keeps its own
        // long-standing look (a colored border on all sides, tint,
        // cursor-pointer) — but re-asserts border-r-transparent explicitly
        // so the general border-primary/45 above doesn't bleed onto the
        // reserved right edge (twMerge only drops a directional class for
        // a later *general* one, not the reverse) and echo even a muted
        // version of the connected accent on a row that isn't connected.
        canOpenSubmittedReview
          ? "cursor-pointer border-primary/45 border-r-transparent bg-primary/[0.06] hover:bg-primary/10"
          : // Connected row: the same solid right-edge border treatment the
            // top-level agent card uses for "this is what's connected"
            // (agents-view.tsx's borderForAgentState), so the signal reads
            // consistently across both list levels — and exclusively means
            // "connected," not shared with any other state. state ===
            // "active" (not the bare isConnected prop) so this exactly
            // matches the top-level card's own condition (use-agents.ts's
            // agentVisualState: running/creating AND actually connected).
            // isConnected alone would keep the accent lit for a
            // paused-but-still-attached agent, or after the terminal
            // socket drops — both cases where the top-level card already
            // goes transparent, so the two would disagree about the same
            // fact.
            state === "active" && "border-r-status-done",
        isStopped && "opacity-65",
        canOpenSubmittedReview && "opacity-100",
        showReviewActivity && "child-agent-review-active-row"
      )}
    >
      {canOpenSubmittedReview ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={`child-agent-open-review-${agent.id}`}
              aria-label={`Open submitted review from ${displayName}`}
              className="absolute inset-0 z-0 rounded-l-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                openSubmittedReview(agent);
              }}
            />
          </TooltipTrigger>
          <TooltipContent>Open submitted review</TooltipContent>
        </Tooltip>
      ) : null}
      <AgentTypeIcon
        type={agent.type}
        eventType={
          agent.status === "running" ? agent.latestEvent?.type : undefined
        }
        className="pointer-events-none relative z-10 h-4.5 w-4.5"
      />
      <div className="pointer-events-none relative z-10 min-w-0 flex-1">
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
        Right-side action cluster: REVIEW badge, terminal icon, overflow menu.
        Grouped in one shrink-0 flex container (rather than the badge living
        inside the shrinking label) so the label is the only thing that gives
        way to a long name — this cluster never competes with it for space.
      */}
      <div className="pointer-events-none relative z-10 flex shrink-0 items-center gap-1 [&_button]:pointer-events-auto">
        {isReviewAgent ? (
          <Badge
            className={cn(
              "h-4 border-primary px-1 text-[8px] font-semibold uppercase tracking-wide",
              canOpenSubmittedReview
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground"
            )}
          >
            Review
          </Badge>
        ) : null}
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
        ) : isConnected ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                data-agent-control="true"
                data-testid={`child-agent-detach-${agent.id}`}
                aria-label={`Detach from ${displayName}`}
                className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
                onClick={detachTerminal}
              >
                <Unplug className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Detach</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                data-agent-control="true"
                data-testid={`child-agent-attach-${agent.id}`}
                aria-label={`Attach to ${displayName}`}
                className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
                onClick={() => {
                  if (closeOnSessionAction) onRequestClose?.();
                  void attachToAgent(agent);
                }}
              >
                <Terminal className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>View terminal</TooltipContent>
          </Tooltip>
        )}
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
          <DropdownMenuContent align="end">
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

  if (!canOpenSubmittedReview) return row;
  return (
    <TipSpot
      tipId="review-row-open"
      side="bottom"
      align="center"
      triggerClassName="flex w-full"
    >
      {row}
    </TipSpot>
  );
}
