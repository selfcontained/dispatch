import { type RefObject } from "react";
import { Hash, MessageSquare, TerminalSquare } from "lucide-react";

import { ChatPane } from "@/components/app/chat/chat-pane";
import { type Agent, type MediaFile } from "@/components/app/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBadgeCount } from "@/lib/format";
import { type AgentPaneView, isAgentPaneView } from "@/lib/store";
import { cn } from "@/lib/utils";

export type AgentViewToggleProps = {
  view: AgentPaneView;
  onViewChange: (view: AgentPaneView) => void;
  /** Unread chat replies; shown on the Chat segment while Console is up. */
  chatUnreadCount?: number;
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
}: AgentViewToggleProps): JSX.Element {
  const showUnread = view === "console" && chatUnreadCount > 0;
  return (
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
    >
      <ToggleGroupItem
        value="chat"
        aria-label="Chat"
        data-testid="agent-view-chat"
        className="relative"
      >
        <MessageSquare className="h-3 w-3" />
        Chat
        {showUnread ? (
          <span
            data-testid="agent-view-chat-unread"
            aria-label={`${chatUnreadCount} unread chat messages`}
            className="ml-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-4 text-primary-foreground"
          >
            {formatBadgeCount(chatUnreadCount)}
          </span>
        ) : null}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="console"
        aria-label="Console"
        data-testid="agent-view-console"
      >
        <TerminalSquare className="h-3 w-3" />
        Console
      </ToggleGroupItem>
    </ToggleGroup>
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
  terminalSlotRef,
  header,
  openLightbox,
  isMobile,
}: AgentPaneProps): JSX.Element {
  const chatShown = chatEnabled && view === "chat";
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="agent-pane"
      data-view={chatEnabled ? view : undefined}
    >
      {chatEnabled && header ? (
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border/40 pl-3 pr-2 pointer-coarse:py-1">
          <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{agent?.name ?? "Agent"}</span>
          </span>
          <AgentViewToggle
            view={view}
            onViewChange={onViewChange}
            chatUnreadCount={chatUnreadCount}
          />
        </div>
      ) : null}
      {chatEnabled ? (
        <div
          className={cn("min-h-0 flex-1", !chatShown && "hidden")}
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
            openLightbox={openLightbox}
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
