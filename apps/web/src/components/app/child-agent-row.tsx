import {
  Archive,
  ClipboardList,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  MessageSquare,
  Unplug,
} from "lucide-react";

import { describeAgentStatus } from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { ChatUnreadBadge } from "@/components/app/chat/chat-unread-badge";
import { type Agent, type AgentVisualState } from "@/components/app/types";
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
  openAgent: (agent: Agent) => Promise<void>;
  closeAgent: () => void;
  startAgent: (agent: Agent) => Promise<void>;
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
  openAgent,
  closeAgent,
  startAgent,
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
  const showReviewActivity =
    isReviewAgent && agent.status === "running" && isInitialReviewActive;
  // A paused or errored reviewer needs its own wording rather than a
  // blanket "Review in progress."
  const reviewPendingLabel =
    agent.status === "error"
      ? "Review agent — stopped with an error"
      : isStopped
        ? "Review agent — paused"
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
      onClick={(event) => {
        // Mirrors the top-level agent card's row-click-to-open/close
        // (agent-card-header.tsx): a data-agent-control="true" marker plus
        // closest() lets interactive descendants (the overflow menu, the
        // resume button) opt out of the row's own click, the same
        // convention that file uses instead of stopPropagation.
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
          closeAgent();
          return;
        }
        if (closeOnSessionAction) onRequestClose?.();
        void openAgent(agent);
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
        // that thickens this edge at all, exclusively means "connected."
        // state === "active" (not the bare isConnected prop) so this exactly matches
        // the top-level card's own condition (use-agents.ts's
        // agentVisualState: running/creating AND actually connected).
        state === "active" && "border-r-4 border-r-status-done",
        isStopped && "opacity-65",
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
        Right-side action cluster: reviewer badge, resume button (stopped
        agents only), overflow menu. Grouped in one shrink-0 flex container
        (rather than the badge living inside the shrinking label) so the
        label is the only thing that gives way to a long name — this
        cluster never competes with it for space. Plain elements here (no
        pointer-events tricks needed): a click anywhere in the cluster that
        isn't a real control just bubbles up to the row's own onClick, same
        as clicking blank space anywhere else in the row.
      */}
      <div className="flex shrink-0 items-center gap-1">
        <ChatUnreadBadge
          agentId={agent.id}
          className="h-4 px-1 text-[10px] leading-none"
        />
        {isReviewAgent ? (
          // Decorative only — the row's own status line already says
          // "Working"/etc.; this just marks the agent as a reviewer. Its
          // review lands in the parent's stream as a review block.
          <span
            role="img"
            aria-label={reviewPendingLabel}
            title={reviewPendingLabel}
            className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground sm:h-7 sm:w-7"
          >
            <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
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
          Session lifecycle controls: the pause/rename/archive an agent card
          carries in its footer. They live behind an overflow menu because the
          row has one action slot.
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
              // The keyboard/screen-reader path to open the sub agent's page
              // (the row's own click has no non-mouse equivalent). Label and
              // action both follow isConnectedActive, matching what the row's
              // own accent and click already mean by "open."
              <DropdownMenuItem
                className={menuItemClass}
                data-testid={`child-agent-open-${agent.id}`}
                onSelect={() => {
                  if (isConnectedActive) {
                    closeAgent();
                    return;
                  }
                  if (closeOnSessionAction) onRequestClose?.();
                  void openAgent(agent);
                }}
              >
                {isConnectedActive ? (
                  <Unplug className="h-3.5 w-3.5" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5" />
                )}
                {isConnectedActive ? "Close" : "Open"}
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
