import { type RefObject } from "react";
import { Hash, ListFilter, MessageSquare, TerminalSquare } from "lucide-react";

import { ChatPane } from "@/components/app/chat/chat-pane";
import { type Agent, type MediaFile } from "@/components/app/types";
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
   * Render the pane's own header row (agent name + toggle). A split pane
   * has a header of its own and puts `AgentViewToggle` there instead.
   */
  header: boolean;
  openLightbox: (file: MediaFile) => void;
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
  header,
  openLightbox,
  onOpenReview,
  isMobile,
}: AgentPaneProps): JSX.Element {
  const chatShown = chatEnabled && view === "chat";
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
      {chatEnabled ? (
        <div
          className={cn(
            "min-h-0 min-w-0 max-w-full flex-1 overflow-hidden",
            !chatShown && "hidden"
          )}
          data-testid="agent-pane-chat"
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
        </div>
      ) : null}
      <div
        ref={terminalSlotRef}
        className={cn("min-h-0 flex-1", chatShown && "hidden")}
        data-testid="agent-pane-console"
      />
    </div>
  );
}
