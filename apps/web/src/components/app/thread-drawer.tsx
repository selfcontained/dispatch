import { useMemo } from "react";
import { MotionConfig } from "framer-motion";
import { ArrowLeft, X } from "lucide-react";

import { threadTitle } from "@/components/app/chat/thread-panel";
import {
  DrawerStack,
  type DrawerPage,
} from "@/components/app/drawer/drawer-stack";
import { ThreadPage } from "@/components/app/drawer/thread-page";
import { TurnPage, useTurnEntry } from "@/components/app/drawer/turn-page";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { useDrawerRoute } from "@/hooks/use-drawer-route";
import { useThread } from "@/hooks/use-stream";
import { cn } from "@/lib/utils";

export type ThreadDrawerProps = {
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  /** The root of the selected agent's lineage: the stream the thread lives in. */
  rootId: string | null;
  /** Names an agent in the selected agent's tree. */
  agentNameById?: (agentId: string) => string;
  /** The page's agent: the thread pages post as it and read its state. */
  agent?: Agent | null;
  openLightbox: (fileId: number) => void;
  /** Opens the Changes tab on a file, at a line when one is given. */
  onOpenPath?: (path: string, line: number | null) => void;
  isMobile?: boolean;
  className?: string;
};

/**
 * A thread (or a review, or another agent's turn) open beside the stream,
 * from the URL. Its own panel, not a page over the sidebar: closing it
 * returns to the stream, and the sidebar is wherever it was. Only a
 * finding stacks over its review inside it, with a way back to the
 * review; everywhere else the one control is close.
 */
export function ThreadDrawer({
  selectedAgentId,
  selectedAgentName,
  rootId,
  agentNameById,
  agent = null,
  openLightbox,
  onOpenPath,
  isMobile = false,
  className,
}: ThreadDrawerProps): JSX.Element | null {
  const route = useDrawerRoute();
  const live = Boolean(selectedAgentId && rootId);
  const threadId = live ? route.threadId : null;
  const findingId = threadId ? route.findingId : null;
  const turnId = live ? route.turnId : null;
  const thread = useThread(rootId, threadId);
  const turn = useTurnEntry(rootId, turnId);
  const nameOf = (agentId: string) =>
    agentId === selectedAgentId
      ? (selectedAgentName ?? "Agent")
      : (agentNameById?.(agentId) ?? "Agent");
  const heading = turnId
    ? { title: "Turn", subtitle: turn ? `by ${nameOf(turn.agentId)}` : "" }
    : threadTitle(thread.root, findingId !== null, nameOf);
  const { openThread, openTurn, back, closeAll } = route;

  const pages = useMemo<DrawerPage[]>(() => {
    if (!selectedAgentId || !rootId) return [];
    if (turnId) {
      return [
        {
          key: `turn:${turnId}`,
          node: (
            <TurnPage
              rootId={rootId}
              turnId={turnId}
              openLightbox={openLightbox}
              onOpenPath={onOpenPath}
              onOpenThread={openThread}
            />
          ),
        },
      ];
    }
    if (!threadId) return [];
    // One page per level: moving between findings on the same review
    // changes what the finding page shows rather than swapping pages.
    const page = (finding: string | null): DrawerPage => ({
      key: finding ? `finding:${threadId}` : `thread:${threadId}`,
      node: (
        <ThreadPage
          agentId={selectedAgentId}
          agent={agent}
          rootId={rootId}
          blockId={threadId}
          findingId={finding}
          isMobile={isMobile}
          openLightbox={openLightbox}
          onOpenPath={onOpenPath}
          onOpenThread={openThread}
          onOpenTurn={openTurn}
          onBack={back}
        />
      ),
    });
    return findingId ? [page(null), page(findingId)] : [page(null)];
  }, [
    agent,
    back,
    findingId,
    isMobile,
    onOpenPath,
    openLightbox,
    openThread,
    openTurn,
    rootId,
    selectedAgentId,
    threadId,
    turnId,
  ]);

  if (pages.length === 0) return null;
  const depth = pages.length;

  return (
    <aside
      data-testid="thread-drawer"
      data-depth={depth}
      className={cn(
        "flex h-full min-h-0 w-full flex-col text-foreground",
        className
      )}
      aria-label={heading.title}
    >
      <div className="flex min-h-14 items-center gap-1 pl-1.5 pr-2 pt-[env(safe-area-inset-top)]">
        {depth > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Back"
            data-testid="drawer-back"
            onClick={back}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : (
          <span className="w-2" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-semibold text-foreground"
            data-testid="drawer-title"
          >
            {heading.title}
          </div>
          {heading.subtitle ? (
            <div
              className="truncate text-[11.5px] text-muted-foreground"
              data-testid="drawer-subtitle"
            >
              {heading.subtitle}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Close"
          title="Close"
          data-testid="drawer-close"
          onClick={closeAll}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <MotionConfig reducedMotion="user">
        <DrawerStack pages={pages} />
      </MotionConfig>
    </aside>
  );
}
