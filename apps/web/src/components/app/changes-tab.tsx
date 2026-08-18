import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import { FileDiff, Loader2 } from "lucide-react";
import { parseDiff } from "react-diff-view";

import { useAgentDiff } from "@/hooks/use-agent-diff";
import {
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffHideTestFilesAtom,
  diffFileTreeOpenAtom,
  diffViewStateAtomFamily,
  reviewDraftAtomFamily,
} from "@/lib/store";
import { excludeTestFiles } from "@/lib/test-files";
import { ReviewModeBar } from "@/components/app/review-mode";
import { useAllReviewFeedbackItems } from "@/hooks/use-agent-reviews";
import {
  findLastChangeKeyInRange,
  type LineSelection,
} from "@/components/app/unified-diff-utils";
import { FileTree } from "@/components/app/changes-file-tree";
import { DiffPane } from "@/components/app/changes-diff-section";

type ChangesTabProps = {
  agentId: string | null;
  active: boolean;
  isMobile?: boolean;
  onReviewSubmitted?: (reviewId: number) => void;
};

export const ChangesTab = memo(function ChangesTab({
  agentId,
  active,
  isMobile,
  onReviewSubmitted,
}: ChangesTabProps): JSX.Element {
  const storedViewType = useAtomValue(diffViewTypeAtom);
  const viewType = isMobile ? "unified" : storedViewType;
  const ignoreWhitespace = useAtomValue(diffIgnoreWhitespaceAtom);
  const hideTestFiles = useAtomValue(diffHideTestFilesAtom);
  const { data, isLoading } = useAgentDiff(agentId, active, ignoreWhitespace);
  const feedbackItems = useAllReviewFeedbackItems(agentId, active);
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
  const [focusedFeedbackItemId, setFocusedFeedbackItemId] = useState<
    number | null
  >(null);
  const handleFeedbackFocusComplete = useCallback((feedbackItemId: number) => {
    setFocusedFeedbackItemId((current) =>
      current === feedbackItemId ? null : current
    );
  }, []);
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
  const navFeedbackTarget = searchParams.get("feedback");

  const files = useMemo(
    () =>
      (hideTestFiles
        ? excludeTestFiles(data?.files ?? [], navFileTarget)
        : [...(data?.files ?? [])]
      ).sort((a, b) => a.path.localeCompare(b.path)),
    [data?.files, hideTestFiles, navFileTarget]
  );

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
    const feedbackItemId = navFeedbackTarget ? Number(navFeedbackTarget) : null;
    setFocusedFeedbackItemId(
      feedbackItemId != null && Number.isInteger(feedbackItemId)
        ? feedbackItemId
        : null
    );
    setSearchParams({}, { replace: true });
    if (targetFile) {
      requestAnimationFrame(() => {
        scrollToFile(navFileTarget);
        if (!navFeedbackTarget && navLineTarget && targetFile.diff) {
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
    navFeedbackTarget,
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

  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-sm">Loading changes…</span>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileDiff className="h-8 w-8" />
        <p className="text-sm">
          {hideTestFiles && data?.files.length
            ? "No non-test changes"
            : "No changes yet"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {reviewMode && agentId && (
        <ReviewModeBar
          agentId={agentId}
          drafts={draftComments}
          onClearDrafts={clearDrafts}
          onExitReview={() => setReviewMode(false)}
          onReviewSubmitted={(reviewId) => {
            setReviewMode(false);
            onReviewSubmitted?.(reviewId);
          }}
        />
      )}
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
          feedbackItems={feedbackItems}
          focusedFeedbackItemId={focusedFeedbackItemId}
          onFeedbackFocusComplete={handleFeedbackFocusComplete}
        />
      </div>
    </div>
  );
});
