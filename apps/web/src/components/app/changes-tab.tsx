import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockFindingPatch, BlockReviewSeverity } from "@dispatch/shared";
import { reviewFindings } from "@dispatch/shared";
import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import { FileDiff, Loader2, MessageSquarePlus } from "lucide-react";
import { parseDiff } from "react-diff-view";

import { useAgentDiff } from "@/hooks/use-agent-diff";
import { useRootAgentId } from "@/hooks/use-agent-tree";
import { useDrawerRoute } from "@/hooks/use-drawer-route";
import { useSetBlockState } from "@/hooks/use-stream";
import { useInbox } from "@/hooks/use-inbox";
import type {
  DiffFinding,
  DiffFindingsProps,
} from "@/components/app/diff-review-annotation-props";
import {
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffHideTestFilesAtom,
  diffFileTreeOpenAtom,
  diffViewStateAtomFamily,
  reviewDraftAtomFamily,
} from "@/lib/store";
import { useVisibleDiffFiles } from "@/hooks/use-visible-diff";
import { PersonaLauncher } from "@/components/app/persona-launcher";
import { ReviewModeBar } from "@/components/app/review-mode";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AgentType } from "@/lib/agent-types";
import { FINDING_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import {
  findLastChangeKeyInRange,
  type LineSelection,
} from "@/components/app/unified-diff-utils";
import { FileTree } from "@/components/app/changes-file-tree";
import { DiffPane } from "@/components/app/changes-diff-section";

type ChangesTabProps = {
  agentId: string | null;
  agent: Agent | null;
  enabledAgentTypes: AgentType[];
  active: boolean;
  isMobile?: boolean;
  /** A hand-written review was posted as a review block. */
  onReviewPosted?: (blockId: string) => void;
  /** Names an agent in the tree, for who left a finding. */
  agentNameById?: (agentId: string) => string;
};

/**
 * The toolbar above the diff: launch personas (reviewers) as children of
 * this agent, or review the diff by hand and post it as a review block.
 */
function ChangesToolbar({
  agent,
  enabledAgentTypes,
  onStartReview,
}: {
  agent: Agent;
  enabledAgentTypes: AgentType[];
  onStartReview: () => void;
}): JSX.Element {
  const isStopped = agent.status !== "running";
  // The launcher's disabled and error states are tooltips, and the tab has
  // no provider of its own above it (the sidebar card's footer does).
  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5"
        data-testid="changes-toolbar"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Review
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="changes-start-review"
          onClick={onStartReview}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          Leave a review
        </Button>
        <PersonaLauncher
          agent={agent}
          enabledAgentTypes={enabledAgentTypes}
          label="Launch personas"
          disabled={isStopped || agent.status === "archiving"}
          disabledReason={
            isStopped
              ? "Agent is stopped — start it before launching a persona."
              : agent.status === "archiving"
                ? "Agent is archiving."
                : undefined
          }
        />
      </div>
    </TooltipProvider>
  );
}

export const ChangesTab = memo(function ChangesTab({
  agentId,
  agent,
  enabledAgentTypes,
  active,
  isMobile,
  onReviewPosted,
  agentNameById,
}: ChangesTabProps): JSX.Element {
  // A hand-written review is a block in the agent's stream: the root's.
  // Nothing is fetched while the tab is inactive.
  const rootId = useRootAgentId(active ? agentId : null);

  // The reviews of this agent's work, from the stream the Chat tab holds:
  // each finding with a path is placed in the diff at its line.
  const inbox = useInbox(active ? agentId : null);
  const nameOf = useCallback(
    (id: string) =>
      id === agentId
        ? (agent?.name ?? "Agent")
        : (agentNameById?.(id) ?? "Agent"),
    [agent?.name, agentId, agentNameById]
  );
  const findingItems = useMemo<DiffFinding[]>(
    () =>
      inbox.reviews.flatMap((block) =>
        reviewFindings(block)
          .filter((finding) => finding.data.path)
          .map((finding) => ({
            key: finding.id,
            block,
            findingId: finding.id,
            finding: finding.data,
            record: finding.state ?? null,
            reviewerName:
              block.author.kind === "agent"
                ? nameOf(block.author.agentId)
                : "You",
          }))
      ),
    [nameOf, inbox.reviews]
  );
  const [focusedFindingKey, setFocusedFindingKey] = useState<string | null>(
    null
  );
  const onFindingFocusComplete = useCallback((key: string) => {
    setFocusedFindingKey((current) => (current === key ? null : current));
  }, []);
  const { openThread } = useDrawerRoute();
  const { mutate: setBlockStateNow } = useSetBlockState(rootId);
  const onSetFindingState = useCallback(
    (findingId: string, patch: BlockFindingPatch) =>
      setBlockStateNow({ blockId: findingId, state: patch }),
    [setBlockStateNow]
  );
  const findings = useMemo<DiffFindingsProps | undefined>(
    () =>
      findingItems.length > 0
        ? {
            items: findingItems,
            focusedKey: focusedFindingKey,
            onFocusComplete: onFindingFocusComplete,
            onOpen: openThread,
            onSetState: onSetFindingState,
            disabled: !agent || agent.status !== "running",
            nameOf,
          }
        : undefined,
    [
      agent,
      findingItems,
      focusedFindingKey,
      nameOf,
      onFindingFocusComplete,
      onSetFindingState,
      openThread,
    ]
  );
  const storedViewType = useAtomValue(diffViewTypeAtom);
  const viewType = isMobile ? "unified" : storedViewType;
  const ignoreWhitespace = useAtomValue(diffIgnoreWhitespaceAtom);
  const hideTestFiles = useAtomValue(diffHideTestFilesAtom);
  const { data, isLoading } = useAgentDiff(agentId, active, ignoreWhitespace);
  const [viewState, setViewState] = useAtom(
    diffViewStateAtomFamily(agentId ?? "")
  );

  const [reviewState, setReviewState] = useAtom(
    reviewDraftAtomFamily(agentId ?? "")
  );
  const reviewMode = reviewState.reviewMode;
  const draftComments = reviewState.drafts;

  const setReviewMode = useCallback(
    (mode: boolean) => {
      setReviewState((prev) => ({ ...prev, reviewMode: mode }));
    },
    [setReviewState]
  );

  const addDraft = useCallback(
    (filePath: string, startLine: number, endLine: number, comment: string) => {
      setReviewState((prev) => ({
        ...prev,
        drafts: [
          ...prev.drafts,
          {
            id: `draft-${prev.nextId}`,
            filePath,
            startLine,
            endLine,
            comment,
          },
        ],
        nextId: prev.nextId + 1,
      }));
    },
    [setReviewState]
  );

  const removeDraft = useCallback(
    (id: string) => {
      setReviewState((prev) => {
        const next = prev.drafts.filter((d) => d.id !== id);
        return {
          ...prev,
          drafts: next,
          reviewMode: next.length === 0 ? false : prev.reviewMode,
        };
      });
    },
    [setReviewState]
  );

  const updateDraft = useCallback(
    (id: string, comment: string) => {
      setReviewState((prev) => ({
        ...prev,
        drafts: prev.drafts.map((d) => (d.id === id ? { ...d, comment } : d)),
      }));
    },
    [setReviewState]
  );

  const setDraftSeverity = useCallback(
    (id: string, severity: BlockReviewSeverity) => {
      setReviewState((prev) => ({
        ...prev,
        drafts: prev.drafts.map((d) => (d.id === id ? { ...d, severity } : d)),
      }));
    },
    [setReviewState]
  );

  const clearDrafts = useCallback(() => {
    setReviewState((prev) => ({
      ...prev,
      drafts: [],
      reviewMode: false,
      nextId: 0,
    }));
  }, [setReviewState]);

  const collapsedFiles = useMemo(
    () => new Set(viewState.collapsedFiles),
    [viewState.collapsedFiles]
  );
  const collapsedDirs = useMemo(
    () => new Set(viewState.collapsedDirs),
    [viewState.collapsedDirs]
  );

  const toggleCollapseFile = useCallback(
    (path: string) => {
      setViewState((prev) => {
        const s = new Set(prev.collapsedFiles);
        if (s.has(path)) s.delete(path);
        else s.add(path);
        return { ...prev, collapsedFiles: [...s] };
      });
    },
    [setViewState]
  );

  const toggleCollapseDir = useCallback(
    (path: string) => {
      setViewState((prev) => {
        const s = new Set(prev.collapsedDirs);
        if (s.has(path)) s.delete(path);
        else s.add(path);
        return { ...prev, collapsedDirs: [...s] };
      });
    },
    [setViewState]
  );

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(
    null
  );
  const [commentOpen, setCommentOpen] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useAtom(diffFileTreeOpenAtom);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleLineSelection = useCallback((sel: LineSelection | null) => {
    setLineSelection(sel);
    setCommentOpen(false);
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const navFileTarget = searchParams.get("file");
  const navLineTarget = searchParams.get("line");
  // `?thread=<review's thread>&finding=<id>` beside `file`: the finding to
  // open in place. Those two stay in the URL; they are the drawer's page.
  const navFindingKey =
    searchParams.get(THREAD_PARAM) && searchParams.get(FINDING_PARAM)
      ? searchParams.get(FINDING_PARAM)
      : null;

  const files = useVisibleDiffFiles(data, navFileTarget);

  const scrollToFile = useCallback(
    (path: string) => {
      setSelectedFile(path);
      const el = fileRefs.current.get(path);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setViewState((prev) => {
        const s = new Set(prev.collapsedFiles);
        if (!s.has(path)) return prev;
        s.delete(path);
        return { ...prev, collapsedFiles: [...s] };
      });
    },
    [setViewState]
  );

  useEffect(() => {
    if (!navFileTarget || files.length === 0) return;
    const targetFile = files.find((f) => f.path === navFileTarget);
    if (isMobile) setFileTreeOpen(false);
    setFocusedFindingKey(navFindingKey);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("file");
        next.delete("line");
        return next;
      },
      { replace: true }
    );
    if (targetFile) {
      requestAnimationFrame(() => {
        scrollToFile(navFileTarget);
        if (!navFindingKey && navLineTarget && targetFile.diff) {
          const lineNum = Number(navLineTarget);
          if (Number.isInteger(lineNum) && lineNum > 0) {
            requestAnimationFrame(() => {
              try {
                const parsed = parseDiff(targetFile.diff!, {
                  nearbySequences: "zip",
                });
                const hunks = parsed[0]?.hunks ?? [];
                const changeKey = findLastChangeKeyInRange(
                  hunks,
                  lineNum,
                  lineNum
                );
                if (changeKey) {
                  const changeCell = scrollRef.current?.querySelector(
                    `[data-change-key="${CSS.escape(changeKey)}"]`
                  );
                  changeCell
                    ?.closest("tr")
                    ?.scrollIntoView({ block: "center", behavior: "smooth" });
                }
              } catch {
                // diff parse failed — fall back to file-level scroll
              }
            });
          }
        }
      });
    }
  }, [
    navFileTarget,
    navLineTarget,
    navFindingKey,
    files,
    isMobile,
    scrollToFile,
    setFileTreeOpen,
    setSearchParams,
  ]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Position of the latest scroll event, kept so the unmount flush below has a
  // value to write: React detaches `scrollRef` before effect cleanups run, so
  // the pane can no longer be measured by then.
  const pendingScrollTopRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    const top = scrollRef.current?.scrollTop ?? 0;
    pendingScrollTopRef.current = top;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      pendingScrollTopRef.current = null;
      setViewState((prev) => {
        if (prev.scrollTop === top) return prev;
        return { ...prev, scrollTop: top };
      });
    }, 300);
  }, [setViewState]);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
        const top = pendingScrollTopRef.current;
        pendingScrollTopRef.current = null;
        if (top === null) return;
        setViewState((prev) => {
          if (prev.scrollTop === top) return prev;
          return { ...prev, scrollTop: top };
        });
      }
    };
    // `setViewState` changes identity when `agentId` does, so this also runs
    // on an agent switch — disarming both refs there is what keeps the
    // outgoing agent's offset from landing on the incoming one.
  }, [setViewState]);

  const restoredScrollForAgent = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || restoredScrollForAgent.current === agentId) return;
    el.scrollTop = viewState.scrollTop;
    restoredScrollForAgent.current = agentId;
  }, [agentId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return <div />;

  const toolbar =
    agent && agentId ? (
      reviewMode ? (
        <ReviewModeBar
          agentId={agentId}
          rootId={rootId}
          drafts={draftComments}
          onClearDrafts={clearDrafts}
          onRemoveDraft={removeDraft}
          onSetDraftSeverity={setDraftSeverity}
          onExitReview={() => setReviewMode(false)}
          onReviewPosted={(blockId) => {
            setReviewMode(false);
            onReviewPosted?.(blockId);
          }}
        />
      ) : (
        <ChangesToolbar
          agent={agent}
          enabledAgentTypes={enabledAgentTypes}
          onStartReview={() => setReviewMode(true)}
        />
      )
    ) : null;

  if (isLoading && !data) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          <span className="text-sm">Loading changes…</span>
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FileDiff className="h-8 w-8" />
          <p className="text-sm">
            {hideTestFiles && data?.files.length
              ? "No non-test changes"
              : "No changes yet"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        <FileTree
          files={files}
          selectedFile={selectedFile}
          onSelectFile={scrollToFile}
          open={fileTreeOpen}
          onToggleOpen={() => setFileTreeOpen((v) => !v)}
          collapsedDirs={collapsedDirs}
          onToggleDir={toggleCollapseDir}
        />
        <DiffPane
          agentId={agentId}
          files={files}
          collapsedFiles={collapsedFiles}
          onToggleCollapse={toggleCollapseFile}
          fileRefs={fileRefs}
          lineSelection={lineSelection}
          onLineSelection={handleLineSelection}
          commentOpen={commentOpen}
          onCommentOpen={setCommentOpen}
          viewType={viewType}
          ignoreWhitespace={ignoreWhitespace}
          scrollRef={scrollRef}
          onScroll={handleScroll}
          reviewMode={reviewMode}
          draftComments={draftComments}
          onAddDraft={addDraft}
          onRemoveDraft={removeDraft}
          onUpdateDraft={updateDraft}
          onStartReview={() => setReviewMode(true)}
          findings={findings}
        />
      </div>
    </div>
  );
});
