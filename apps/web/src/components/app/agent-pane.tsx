import { Hash, ListFilter } from "lucide-react";

import { ChatPane } from "@/components/app/chat/chat-pane";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type ChatFiltersButtonProps = {
  showChildAgents?: boolean;
  onShowChildAgentsChange?: (show: boolean) => void;
};

/** The Chat filters popover in the Agent pane header. */
export function ChatFiltersButton({
  showChildAgents = true,
  onShowChildAgentsChange,
}: ChatFiltersButtonProps): JSX.Element {
  const filtersLabel = showChildAgents
    ? "Chat filters"
    : "Chat filters, child agents hidden";
  return (
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
            "group h-7 w-7 shrink-0 rounded-full p-0 hover:bg-transparent focus-visible:ring-0 pointer-coarse:h-11 pointer-coarse:w-11",
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
              Child agents
            </span>
            <span className="block text-xs text-muted-foreground">
              Show what the agents under this one did and posted.
            </span>
          </span>
          <Switch
            id="show-child-agents"
            checked={showChildAgents}
            onCheckedChange={onShowChildAgentsChange}
            aria-label="Child agents"
            data-testid="show-child-agents-switch"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}

export type AgentPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  /** The pane is on screen (its tab is active, or it sits in a split). */
  active: boolean;
  showChildAgents: boolean;
  onShowChildAgentsChange: (show: boolean) => void;
  /**
   * Render the pane's own header row (agent name + filters). A split pane
   * has a header of its own and puts `ChatFiltersButton` there instead.
   */
  header: boolean;
  openLightbox: (mediaId: number) => void;
  /** Opens the Changes tab on a file (a review finding's path). */
  onOpenPath?: (path: string, line: number | null) => void;
  isMobile: boolean;
};

/** The Agent tab's contents: the agent's Chat feed and composer. */
export function AgentPane({
  agentId,
  agent,
  active,
  showChildAgents,
  onShowChildAgentsChange,
  header,
  openLightbox,
  onOpenPath,
  isMobile,
}: AgentPaneProps): JSX.Element {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden"
      data-testid="agent-pane"
    >
      {header ? (
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border/40 py-1.5 pl-3 pr-2">
          <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{agent?.name ?? "Agent"}</span>
          </span>
          <ChatFiltersButton
            showChildAgents={showChildAgents}
            onShowChildAgentsChange={onShowChildAgentsChange}
          />
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
        {/*
         * Keyed per agent: the pane's dismissed question, send error and
         * scroll position are agent-local, and a direct /agents/a →
         * /agents/b transition must not carry them across.
         */}
        <ChatPane
          key={agentId ?? "none"}
          agentId={agentId}
          agent={agent}
          active={active}
          showChildAgents={showChildAgents}
          onShowChildAgentsChange={onShowChildAgentsChange}
          openLightbox={openLightbox}
          onOpenPath={onOpenPath}
          isMobile={isMobile}
        />
      </div>
    </div>
  );
}
