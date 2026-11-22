import { ConversationReturnLink } from "./chat/conversation-location-link";
import { useMemo, useState } from "react";
import { MotionConfig } from "framer-motion";
import { ArrowLeft } from "lucide-react";

import {
  AuthorMeta,
  Avatar,
  blockIdentity,
} from "@/components/app/chat/chat-entries";
import { threadTitle } from "@/components/app/chat/thread-panel";
import { useChatFeedContext } from "@/components/app/chat/use-chat-feed-context";
import {
  DrawerStack,
  type DrawerPage,
} from "@/components/app/drawer/drawer-stack";
import { ThreadPage } from "@/components/app/drawer/thread-page";
import { SheetClose, useSheetClosing } from "@/components/ui/sheet";
import { type Agent } from "@/components/app/types";
import { useDrawerRoute } from "@/hooks/use-drawer-route";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { useThread } from "@/hooks/use-stream";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";

/** These take the thread's place, or sit over it, on their own click. */
export const THREAD_KEEP_OPEN =
  '[data-background-work-trigger], [data-testid="toggle-drawer"]';

export type ThreadDrawerProps = {
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  /** The root of the selected agent's lineage: the stream the thread lives in. */
  rootId: string | null;
  /** Names an agent in the selected agent's tree. */
  agentNameById?: (agentId: string) => string;
  /** The page's agent: the thread pages post as it and read its state. */
  agent?: Agent | null;
  openLightbox: (fileId: number, order?: number[]) => void;
  /** Opens the Changes tab on a file, at a line when one is given. */
  onOpenPath?: (path: string, line: number | null) => void;
  isMobile?: boolean;
  className?: string;
};

/** What the drawer shows: a thread in an agent's stream, and a finding in it. */
type ThreadTarget = {
  agentId: string;
  rootId: string;
  threadId: string;
  findingId: string | null;
};

function sameTarget(a: ThreadTarget, b: ThreadTarget | null): boolean {
  return (
    b !== null &&
    a.agentId === b.agentId &&
    a.rootId === b.rootId &&
    a.threadId === b.threadId &&
    a.findingId === b.findingId
  );
}

/**
 * A thread (or a review, or another agent's turn) open beside the stream,
 * from the URL. Its own Sheet, not a page over the sidebar: closing it
 * returns to the stream with the sidebar closed. Only a
 * finding stacks over its review inside it, with a way back to the
 * review; everywhere else the one control is close. While its frame
 * slides shut it keeps showing the thread the URL just stopped naming.
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
  const closing = useSheetClosing();
  const current: ThreadTarget | null =
    selectedAgentId && rootId && route.threadId
      ? {
          agentId: selectedAgentId,
          rootId,
          threadId: route.threadId,
          findingId: route.findingId,
        }
      : null;
  // The last thread shown, for the slide shut. Only ever read while
  // closing, and anything open replaces it, so it never shows over a
  // thread the URL names.
  const [held, setHeld] = useState<ThreadTarget | null>(current);
  if (current && !sameTarget(current, held)) setHeld(current);
  const target = current ?? (closing ? held : null);
  const targetAgentId = target?.agentId ?? null;
  const targetRootId = target?.rootId ?? null;
  const threadId = target?.threadId ?? null;
  const findingId = target?.findingId ?? null;
  // Closing after the agent changed, the held thread is the old agent's.
  const pageAgent = targetAgentId === selectedAgentId ? agent : null;
  // The header names the page on top: a finding's own thread when one is
  // open over its review.
  const thread = useThread(targetRootId, findingId ?? threadId);
  const launchedAgent = useAgentRecord(
    thread.root?.kind === "launch" ? thread.root.toAgentId : null
  );
  const nameOf = (agentId: string) =>
    launchedAgent?.id === agentId
      ? launchedAgent.name
      : (thread.agentNames?.[agentId] ??
        (agentId === selectedAgentId
          ? (selectedAgentName ?? "Agent")
          : (agentNameById?.(agentId) ?? "Agent")));
  const heading = threadTitle(thread.root, findingId !== null, nameOf);
  // Who the page is about, as the stream draws them — the reviewer on a
  // finding, the launched agent on its card — so the header keeps their
  // face, engine and model while the page scrolls.
  const { ctx } = useChatFeedContext({
    agentId: targetAgentId,
    rootId: targetRootId,
    agent: pageAgent,
    openLightbox,
  });
  const identity = launchedAgent
    ? {
        key: `peer:${launchedAgent.id}`,
        agentId: launchedAgent.id,
        treeRootId: targetRootId ?? undefined,
        kind: "peer" as const,
        name: launchedAgent.name,
        agentType: launchedAgent.type,
        model: launchedAgent.model,
        ...(launchedAgent.seat !== null ? { seat: launchedAgent.seat } : {}),
      }
    : thread.root
      ? blockIdentity(thread.root, ctx)
      : null;
  const { openThread, back, closeAll } = route;

  const pages = useMemo<DrawerPage[]>(() => {
    if (!targetAgentId || !targetRootId || !threadId) return [];
    // One page per level: moving between findings on the same review
    // changes what the finding page shows rather than swapping pages.
    const page = (finding: string | null): DrawerPage => ({
      key: finding ? `finding:${threadId}` : `thread:${threadId}`,
      node: (
        <ThreadPage
          agentId={targetAgentId}
          agent={pageAgent}
          rootId={targetRootId}
          blockId={threadId}
          findingId={finding}
          isMobile={isMobile}
          openLightbox={openLightbox}
          onOpenPath={onOpenPath}
          onOpenThread={openThread}
          onBack={back}
          escapeHandledByParent
        />
      ),
    });
    return findingId ? [page(null), page(findingId)] : [page(null)];
  }, [
    back,
    findingId,
    isMobile,
    onOpenPath,
    openLightbox,
    openThread,
    pageAgent,
    targetAgentId,
    targetRootId,
    threadId,
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
      <div className="flex min-h-14 shrink-0 items-center gap-1 pb-2 pl-1.5 pr-2 pt-safe-2">
        {depth > 1 ? (
          <IconButton label="Back" data-testid="drawer-back" onClick={back}>
            <ArrowLeft aria-hidden="true" />
          </IconButton>
        ) : (
          <span className="w-2" aria-hidden="true" />
        )}
        {identity && identity.kind !== "user" ? (
          <div className="mr-2 shrink-0" data-testid="drawer-identity">
            <Avatar author={identity} />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-body-md font-semibold text-foreground"
            data-testid="drawer-title"
          >
            {heading.title}
          </div>
          {heading.subtitle ? (
            <div
              className="truncate text-label-sm text-muted-foreground"
              data-testid="drawer-subtitle"
            >
              {heading.subtitle}
            </div>
          ) : null}
          {identity ? (
            <div className="mt-0.5 flex min-w-0" data-testid="drawer-meta">
              <AuthorMeta author={identity} />
            </div>
          ) : null}
        </div>
        <SheetClose data-testid="drawer-close" onClick={closeAll} />
      </div>
      <ConversationReturnLink inDrawer />
      <MotionConfig reducedMotion="user">
        <DrawerStack pages={pages} />
      </MotionConfig>
    </aside>
  );
}
