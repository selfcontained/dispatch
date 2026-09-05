import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Hash, ListFilter, MessageSquare, TerminalSquare } from "lucide-react";

import { ChatPane } from "@/components/app/chat/chat-pane";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBadgeCount } from "@/lib/format";
import { type AgentPaneView, isAgentPaneView } from "@/lib/store";
import { cn } from "@/lib/utils";

const PANE_FADE_OUT_SECONDS = 0.32;
const PANE_FADE_IN_SECONDS = 0.26;

/**
 * The Chat ⇄ Console fade. Framer drives opacity through the Web Animations
 * API, so the fade keeps running on the compositor even when the flip itself
 * janks the main thread — a plain CSS class swap starts late (or visibly
 * restarts) on a phone, where the same commit also wakes the terminal.
 *
 * `visibility` rides along via `transitionEnd`: it flips at the *end* of the
 * fade-out and the *start* of the fade-in, so the outgoing view stays painted
 * while it fades yet is fully unpainted — and out of the tab and
 * accessibility order — once down. That is what keeps the terminal canvas
 * from bleeding through the chat feed; `opacity: 0` alone would not.
 */
function paneFade(shown: boolean) {
  return shown
    ? { opacity: 1, visibility: "visible" as const }
    : { opacity: 0, transitionEnd: { visibility: "hidden" as const } };
}

/**
 * The two views hand over rather than cross-dissolve: the outgoing one fades
 * all the way out, and only then does the incoming one fade in. Sequencing it
 * is a single delay on whichever layer is arriving — they animate against the
 * same clock, so the hand-off needs no coordination beyond this.
 *
 * `instant` collapses both to zero for reduced motion and for the chat-surface
 * flag resolving, neither of which is a view change the user asked for.
 */
function paneTransition(shown: boolean, instant: boolean) {
  if (instant) return { duration: 0, delay: 0 };
  return shown
    ? {
        duration: PANE_FADE_IN_SECONDS,
        delay: PANE_FADE_OUT_SECONDS,
        ease: "easeInOut" as const,
      }
    : { duration: PANE_FADE_OUT_SECONDS, delay: 0, ease: "easeInOut" as const };
}

export type AgentViewToggleProps = {
  view: AgentPaneView;
  onViewChange: (view: AgentPaneView) => void;
  /** Unread chat replies; shown on the Chat segment while Console is up. */
  chatUnreadCount?: number;
  showChildAgents?: boolean;
  onShowChildAgentsChange?: (show: boolean) => void;
};

/**
 * The Chat | Console segmented toggle in the Agent pane header. Flipping it
 * is a view preference, not navigation: both views stay mounted underneath,
 * so the switch is instant and no terminal output is lost.
 */
export function AgentViewToggle({
  view,
  onViewChange,
  chatUnreadCount = 0,
  showChildAgents = true,
  onShowChildAgentsChange,
}: AgentViewToggleProps): JSX.Element {
  const showUnread = view === "console" && chatUnreadCount > 0;
  const filtersLabel = showChildAgents
    ? "Chat filters"
    : "Chat filters, child-agent messages hidden";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ToggleGroup
        type="single"
        size="sm"
        value={view}
        onValueChange={(next) => {
          // Radix reports "" when the pressed segment is pressed again; the
          // pane always shows one of the two, so that is a no-op.
          if (isAgentPaneView(next) && next !== view) onViewChange(next);
        }}
        aria-label="Agent pane view"
        data-testid="agent-view-toggle"
        data-view={view}
        className="relative isolate grid h-6 w-[9.5rem] grid-cols-2 border-0 bg-transparent p-0 shadow-none sm:w-[10rem] pointer-coarse:h-11"
      >
        <span
          aria-hidden="true"
          data-testid="agent-view-track"
          className="pointer-events-none absolute inset-x-0 top-1/2 z-0 h-6 -translate-y-1/2 rounded-full border border-border/70 bg-muted shadow-inner"
        />
        <span
          aria-hidden="true"
          data-testid="agent-view-indicator"
          className={cn(
            "pointer-events-none absolute left-0.5 top-1/2 z-0 h-5 w-[calc(50%-0.25rem)] -translate-y-1/2 rounded-full border border-border bg-background shadow transition-transform duration-200 ease-out motion-reduce:transition-none",
            view === "console" && "translate-x-[calc(100%+0.25rem)]"
          )}
        />
        <ToggleGroupItem
          value="chat"
          aria-label="Chat"
          data-testid="agent-view-chat"
          className="relative z-10 h-5 rounded-full px-2.5 text-[11px] transition-colors duration-200 data-[state=on]:bg-transparent data-[state=on]:text-foreground data-[state=on]:shadow-none pointer-coarse:h-11 pointer-coarse:px-2.5"
        >
          <MessageSquare className="h-2.5 w-2.5 shrink-0" />
          Chat
          {showUnread ? (
            <span
              data-testid="agent-view-chat-unread"
              aria-label={`${chatUnreadCount} unread chat messages`}
              className="ml-0.5 min-w-4 shrink-0 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-4 text-primary-foreground"
            >
              {formatBadgeCount(chatUnreadCount)}
            </span>
          ) : null}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="console"
          aria-label="Console"
          data-testid="agent-view-console"
          className="relative z-10 h-5 rounded-full px-2.5 text-[11px] transition-colors duration-200 data-[state=on]:bg-transparent data-[state=on]:text-foreground data-[state=on]:shadow-none pointer-coarse:h-11 pointer-coarse:px-2.5"
        >
          <TerminalSquare className="h-2.5 w-2.5 shrink-0" />
          Console
        </ToggleGroupItem>
      </ToggleGroup>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={filtersLabel}
            title={filtersLabel}
            data-testid="chat-filters-trigger"
            className={cn(
              "group h-7 w-7 rounded-full p-0 hover:bg-transparent focus-visible:ring-0 pointer-coarse:h-11 pointer-coarse:w-11",
              !showChildAgents && "text-primary"
            )}
          >
            <span
              data-testid="chat-filters-surface"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full transition-colors group-hover:bg-muted/70 group-focus-visible:ring-2 group-focus-visible:ring-ring",
                !showChildAgents && "bg-primary/10"
              )}
            >
              <ListFilter
                data-testid="chat-filters-icon"
                className="h-3.5 w-3.5"
              />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-64 p-3"
          data-testid="chat-filters-popover"
        >
          <div className="mb-2 text-xs font-semibold text-foreground">
            Chat filters
          </div>
          <label
            htmlFor="show-child-agents"
            className="flex cursor-pointer items-center justify-between gap-4 rounded-md px-1 py-1.5"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                Show child agents
              </span>
              <span className="block text-xs text-muted-foreground">
                Include messages between this agent and its children.
              </span>
            </span>
            <Switch
              id="show-child-agents"
              checked={showChildAgents}
              onCheckedChange={onShowChildAgentsChange}
              aria-label="Show child agents"
              data-testid="show-child-agents-switch"
            />
          </label>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export type AgentPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  terminalMode: "tmux" | "inert" | null;
  /** The pane is on screen (its tab is active, or it sits in a split). */
  active: boolean;
  /**
   * With the chat surface off the pane is the bare terminal slot: no
   * header, no Chat, no toggle — exactly the Terminal tab of before.
   */
  chatEnabled: boolean;
  view: AgentPaneView;
  onViewChange: (view: AgentPaneView) => void;
  chatUnreadCount?: number;
  showChildAgents: boolean;
  onShowChildAgentsChange: (show: boolean) => void;
  childAgentIds: readonly string[];
  /**
   * Where the (portaled, long-lived) terminal DOM is parented. Owned by
   * `useCenterPaneLayout`, which moves the terminal between the single-pane
   * slot and the split-pane slot; this component only hosts the element.
   */
  terminalSlotRef: RefObject<HTMLDivElement>;
  /**
   * Chrome that belongs to the Console and nothing else — on mobile, the
   * terminal keyboard toolbar. It sits *inside* the Console layer so its
   * height is charged to that layer alone: the pane's content region, the
   * header above it and the Chat layer beside it all keep the same geometry
   * whichever view is up, which is what lets the flip be a pure cross-fade.
   */
  consoleFooter?: ReactNode;
  /**
   * Render the pane's own header row (agent name + toggle). A split pane
   * has a header of its own and puts `AgentViewToggle` there instead.
   */
  header: boolean;
  openLightbox: (mediaId: number) => void;
  /** Opens a review in the Reviews sidebar; from a review card in the feed. */
  onOpenReview?: (reviewId: number) => void;
  isMobile: boolean;
};

/**
 * The Agent tab's contents: the Chat feed and the Console (terminal) stacked
 * in one pane with a toggle choosing which is visible. Both stay mounted —
 * the terminal so tmux output keeps flowing into it, the chat so an unsent
 * draft (files included) survives a flip — and the hidden one is hidden
 * with CSS only.
 *
 * The terminal slot is always rendered, at the same position in the tree,
 * whatever the flag says: the terminal DOM is reparented into it once, and
 * a slot that came and went with the flag would strand it.
 */
export function AgentPane({
  agentId,
  agent,
  terminalMode,
  active,
  chatEnabled,
  view,
  onViewChange,
  chatUnreadCount = 0,
  showChildAgents,
  onShowChildAgentsChange,
  childAgentIds,
  terminalSlotRef,
  consoleFooter = null,
  header,
  openLightbox,
  onOpenReview,
  isMobile,
}: AgentPaneProps): JSX.Element {
  const chatShown = chatEnabled && view === "chat";
  const reduceMotion = useReducedMotion();
  // The chat-surface flag resolves after the first paint, so the pane can go
  // from "bare terminal" to "Chat over Console" a tick in. That is hydration
  // catching up, not a view change, and it must settle in the same frame —
  // otherwise the Console layer sits there fading out under a toggle that
  // already reads Chat. Only a real Chat ⇄ Console flip is animated.
  const settledChatEnabled = useRef(chatEnabled);
  const hydrating = settledChatEnabled.current !== chatEnabled;
  useEffect(() => {
    settledChatEnabled.current = chatEnabled;
  }, [chatEnabled]);
  const instant = Boolean(reduceMotion) || hydrating;
  return (
    <div
      className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden"
      data-testid="agent-pane"
      data-view={chatEnabled ? view : undefined}
    >
      {chatEnabled && header ? (
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border/40 py-1.5 pl-3 pr-2">
          <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{agent?.name ?? "Agent"}</span>
          </span>
          <AgentViewToggle
            view={view}
            onViewChange={onViewChange}
            chatUnreadCount={chatUnreadCount}
            showChildAgents={showChildAgents}
            onShowChildAgentsChange={onShowChildAgentsChange}
          />
        </div>
      ) : null}
      {/*
       * Chat and Console are stacked, not stitched into the column: both
       * fill the same box so the flip can cross-fade instead of swapping
       * `display`. Console sits on top (later in the DOM) and paints an
       * opaque background, so either direction reads as one fade.
       */}
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
        {chatEnabled ? (
          <motion.div
            className={cn(
              "absolute inset-0 overflow-hidden",
              !chatShown && "pointer-events-none"
            )}
            initial={false}
            animate={paneFade(chatShown)}
            transition={paneTransition(chatShown, instant)}
            data-testid="agent-pane-chat"
            data-state={chatShown ? "shown" : "hidden"}
          >
            {/*
             * Keyed per agent: the pane's dismissed question, send error and
             * scroll position are agent-local, and a direct /agents/a →
             * /agents/b transition must not carry them across.
             */}
            <ChatPane
              key={agentId ?? "none"}
              agentId={agentId}
              agent={agent}
              terminalMode={terminalMode}
              active={active && chatShown}
              showChildAgents={showChildAgents}
              childAgentIds={childAgentIds}
              onShowChildAgentsChange={onShowChildAgentsChange}
              openLightbox={openLightbox}
              onOpenReview={onOpenReview}
              isMobile={isMobile}
            />
          </motion.div>
        ) : null}
        <motion.div
          className={cn(
            "absolute inset-0 grid grid-rows-[minmax(0,1fr)_auto]",
            chatShown && "pointer-events-none"
          )}
          initial={false}
          // Always a defined target, chat surface or not: handing framer
          // `undefined` leaves it with no baseline to animate from, and the
          // first flip after the flag resolves snaps instead of fading.
          // With the surface off `chatShown` is always false, which is the
          // bare-terminal mode's "fully shown" anyway.
          animate={paneFade(!chatShown)}
          transition={paneTransition(!chatShown, instant)}
          data-testid="agent-pane-console"
          data-state={chatShown ? "hidden" : "shown"}
        >
          {/*
           * `min-w-0 overflow-hidden` is load-bearing, not tidiness: the slot
           * is a grid item now, and a grid track sizes to its content. The
           * terminal's rows are routinely wider than a phone — carrying a
           * stale width from a wider fit, or simply long output — so without
           * this the track grows to them and drags the layer, the toolbar
           * included, off the side of the screen.
           */}
          <div
            ref={terminalSlotRef}
            className="min-h-0 min-w-0 overflow-hidden"
            data-testid="agent-pane-terminal-slot"
          />
          {consoleFooter}
        </motion.div>
      </div>
    </div>
  );
}
