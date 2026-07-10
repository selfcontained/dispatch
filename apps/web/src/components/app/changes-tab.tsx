import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { parseDiff } from "react-diff-view";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  useAgentDiff,
  useAgentFileDiff,
  type DiffFile,
  type DiffFileStatus,
} from "@/hooks/use-agent-diff";
import {
  type DiffViewType,
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffFileTreeOpenAtom,
  diffViewStateAtomFamily,
  reviewDraftAtomFamily,
} from "@/lib/store";
import { cn } from "@/lib/utils";
import { ReviewModeBar, type DraftComment } from "@/components/app/review-mode";
import {
  type ReviewFeedbackItem,
  useAllReviewFeedbackItems,
} from "@/hooks/use-agent-reviews";
import {
  UnifiedDiffView,
  findLastChangeKeyInRange,
  type LineSelection,
} from "@/components/app/unified-diff-view";

type ChangesTabProps = {
  agentId: string | null;
  active: boolean;
  isMobile?: boolean;
  onReviewSubmitted?: (reviewId: number) => void;
};

const DIFF_FILE_MIN_HEIGHT = 46;
const DIFF_FILE_MAX_ESTIMATED_HEIGHT = 900;
const DIFF_FILE_LINE_HEIGHT = 22;
const DIFF_FILE_GAP_PX = 12;

export const ChangesTab = memo(function ChangesTab({
  agentId,
  active,
  isMobile,
  onReviewSubmitted,
}: ChangesTabProps): JSX.Element {
  const storedViewType = useAtomValue(diffViewTypeAtom);
  const viewType = isMobile ? "unified" : storedViewType;
  const ignoreWhitespace = useAtomValue(diffIgnoreWhitespaceAtom);
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
  const [forceLoadedFiles, setForceLoadedFiles] = useState<Set<string>>(
    () => new Set()
  );
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(
    null
  );
  const [commentOpen, setCommentOpen] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useAtom(diffFileTreeOpenAtom);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollToVirtualFileRef = useRef<((path: string) => void) | null>(null);

  const handleLineSelection = useCallback((sel: LineSelection | null) => {
    setLineSelection(sel);
    setCommentOpen(false);
  }, []);

  const files = useMemo(
    () => [...(data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    [data?.files]
  );

  const scrollToFile = useCallback(
    (path: string) => {
      setSelectedFile(path);
      const el = fileRefs.current.get(path);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        scrollToVirtualFileRef.current?.(path);
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

  const [searchParams, setSearchParams] = useSearchParams();
  const navFileTarget = searchParams.get("file");
  const navLineTarget = searchParams.get("line");

  useEffect(() => {
    if (!navFileTarget || files.length === 0) return;
    const targetFile = files.find((f) => f.path === navFileTarget);
    setSearchParams({}, { replace: true });
    if (targetFile) {
      requestAnimationFrame(() => {
        scrollToFile(navFileTarget);
        if (navLineTarget && targetFile.diff) {
          const lineNum = Number(navLineTarget);
          if (Number.isInteger(lineNum) && lineNum > 0) {
            let attempts = 0;
            const scrollToLine = () => {
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
                  const el = scrollRef.current?.querySelector(
                    `[id="${CSS.escape(changeKey)}"]`
                  );
                  if (el) {
                    el.scrollIntoView({ block: "center", behavior: "smooth" });
                    return;
                  }
                }
              } catch {
                // diff parse failed — fall back to file-level scroll
              }
              // The target file may need to enter the virtual window first.
              if (attempts++ < 60) requestAnimationFrame(scrollToLine);
            };
            requestAnimationFrame(scrollToLine);
          }
        }
      });
    }
  }, [navFileTarget, navLineTarget, files, scrollToFile, setSearchParams]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScroll = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      const top = scrollRef.current?.scrollTop ?? 0;
      setViewState((prev) => {
        if (prev.scrollTop === top) return prev;
        return { ...prev, scrollTop: top };
      });
    }, 300);
  }, [setViewState]);

  useEffect(() => {
    const el = scrollRef.current;
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        const top = el?.scrollTop ?? 0;
        setViewState((prev) => {
          if (prev.scrollTop === top) return prev;
          return { ...prev, scrollTop: top };
        });
      }
    };
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
        <p className="text-sm">No changes yet</p>
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
          forceLoadedFiles={forceLoadedFiles}
          onForceLoad={(path) => {
            setForceLoadedFiles((prev) => {
              if (prev.has(path)) return prev;
              return new Set(prev).add(path);
            });
          }}
          onRegisterScrollToFile={(fn) => {
            scrollToVirtualFileRef.current = fn;
          }}
        />
      </div>
    </div>
  );
});

function statusIcon(status: DiffFileStatus): JSX.Element {
  switch (status) {
    case "added":
      return <FilePlus className="h-3.5 w-3.5 text-status-working" />;
    case "deleted":
      return <FileMinus className="h-3.5 w-3.5 text-status-blocked" />;
    case "renamed":
      return <FileCode2 className="h-3.5 w-3.5 text-purple-400" />;
    default:
      return <FileText className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function treeFileIcon(file: DiffFile): JSX.Element {
  if (file.status === "renamed")
    return <FileCode2 className="h-3.5 w-3.5 text-purple-400" />;
  if (file.status === "deleted" || (file.deleted > 0 && file.added === 0))
    return <FileMinus className="h-3.5 w-3.5 text-status-blocked" />;
  if (file.status === "added" || (file.added > 0 && file.deleted === 0))
    return <FilePlus className="h-3.5 w-3.5 text-status-working" />;
  return <FileDiff className="h-3.5 w-3.5 text-muted-foreground" />;
}

type FileTreeProps = {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
};

type TreeNode = {
  name: string;
  path: string;
  file?: DiffFile;
  children: Map<string, TreeNode>;
};

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const partPath = parts.slice(0, i + 1).join("/");
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: partPath,
          children: new Map(),
        });
      }
      node = node.children.get(part)!;
    }
    node.file = file;
  }
  return collapseTree(root);
}

function collapseTree(node: TreeNode): TreeNode {
  if (node.children.size === 1 && !node.file) {
    const child = [...node.children.values()][0]!;
    if (child.file && child.children.size === 0) {
      const newChildren = new Map<string, TreeNode>();
      newChildren.set(child.name, child);
      return { ...node, children: newChildren };
    }
    const collapsed: TreeNode = {
      name: node.name ? `${node.name}/${child.name}` : child.name,
      path: child.path,
      file: child.file,
      children: child.children,
    };
    return collapseTree(collapsed);
  }
  const newChildren = new Map<string, TreeNode>();
  for (const [key, child] of node.children) {
    newChildren.set(key, collapseTree(child));
  }
  return { ...node, children: newChildren };
}

function FileTree({
  files,
  selectedFile,
  onSelectFile,
  open,
  onToggleOpen,
  collapsedDirs,
  onToggleDir,
}: FileTreeProps): JSX.Element {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div
      className="flex shrink-0 flex-col border-r border-border/50 bg-muted/20 overflow-hidden transition-[width] duration-200 ease-in-out"
      style={{ width: open ? "14rem" : "2.25rem" }}
    >
      <div className="shrink-0 flex items-center border-b border-border/40 bg-muted/30">
        {open && (
          <span className="flex-1 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </span>
        )}
        <button
          type="button"
          onClick={onToggleOpen}
          className={cn(
            "shrink-0 flex items-center justify-center text-muted-foreground hover:bg-muted/50 cursor-pointer",
            open ? "p-2" : "flex-1 py-2"
          )}
        >
          {open ? (
            <PanelLeftClose className="h-3.5 w-3.5" />
          ) : (
            <PanelLeftOpen className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {(tree.file ? [tree] : [...tree.children.values()]).map((child) => (
            <TreeEntry
              key={child.path}
              node={child}
              depth={0}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              collapsedDirs={collapsedDirs}
              onToggleDir={onToggleDir}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type TreeEntryProps = {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
};

function TreeEntry({
  node,
  depth,
  selectedFile,
  onSelectFile,
  collapsedDirs,
  onToggleDir,
}: TreeEntryProps): JSX.Element {
  const isDir = node.children.size > 0 && !node.file;
  const isCollapsed = collapsedDirs.has(node.path);
  const isSelected = node.file && selectedFile === node.file.path;

  const indent = depth * 16 + 8;

  if (isDir) {
    return (
      <>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/40"
          style={{ paddingLeft: `${indent}px` }}
          title={node.name}
          onClick={() => onToggleDir(node.path)}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        <AnimatePresence initial={false}>
          {!isCollapsed && (
            <motion.div
              key="children"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeInOut" }}
              className="overflow-hidden border-l border-border"
              style={{ marginLeft: `${indent + 7}px` }}
            >
              {[...node.children.values()].map((child) => (
                <TreeEntry
                  key={child.path}
                  node={child}
                  depth={0}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={onToggleDir}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  if (!node.file) return <></>;

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-muted/40",
        isSelected && "bg-muted/60 text-foreground"
      )}
      style={{ paddingLeft: `${indent}px` }}
      title={node.file.path}
      onClick={() => onSelectFile(node.file!.path)}
    >
      {treeFileIcon(node.file)}
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
    </button>
  );
}

type DiffPaneProps = {
  agentId: string | null;
  files: DiffFile[];
  collapsedFiles: Set<string>;
  onToggleCollapse: (path: string) => void;
  fileRefs: React.RefObject<Map<string, HTMLDivElement> | null>;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
  viewType: DiffViewType;
  ignoreWhitespace: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
  reviewMode?: boolean;
  draftComments?: DraftComment[];
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraft?: (id: string) => void;
  onUpdateDraft?: (id: string, comment: string) => void;
  onStartReview?: () => void;
  feedbackItems?: ReviewFeedbackItem[];
  forceLoadedFiles: Set<string>;
  onForceLoad: (path: string) => void;
  onRegisterScrollToFile?: (fn: ((path: string) => void) | null) => void;
};

function DiffPane({
  agentId,
  files,
  collapsedFiles,
  onToggleCollapse,
  fileRefs,
  lineSelection,
  onLineSelection,
  commentOpen,
  onCommentOpen,
  viewType,
  ignoreWhitespace,
  scrollRef,
  onScroll,
  reviewMode,
  draftComments,
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
  onStartReview,
  feedbackItems,
  forceLoadedFiles,
  onForceLoad,
  onRegisterScrollToFile,
}: DiffPaneProps): JSX.Element {
  const fileIndexByPath = useMemo(() => {
    const indexes = new Map<string, number>();
    files.forEach((file, index) => indexes.set(file.path, index));
    return indexes;
  }, [files]);

  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      estimateFileDiffHeight(
        files[index]!,
        collapsedFiles.has(files[index]!.path)
      ),
    getItemKey: (index) => files[index]!.path,
    overscan: 4,
    gap: DIFF_FILE_GAP_PX,
  });

  useEffect(() => {
    onRegisterScrollToFile?.((path: string) => {
      const index = fileIndexByPath.get(path);
      if (index == null) return;
      rowVirtualizer.scrollToIndex(index, {
        align: "start",
        behavior: "smooth",
      });
    });
    return () => onRegisterScrollToFile?.(null);
  }, [fileIndexByPath, onRegisterScrollToFile, rowVirtualizer]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto bg-background px-3 pb-3"
    >
      <div
        className="relative w-full"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index]!;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <FileDiffSection
                agentId={agentId}
                file={file}
                collapsed={collapsedFiles.has(file.path)}
                onToggleCollapse={() => onToggleCollapse(file.path)}
                setRef={(el) => {
                  if (el) {
                    fileRefs.current?.set(file.path, el);
                  } else {
                    fileRefs.current?.delete(file.path);
                  }
                }}
                lineSelection={lineSelection}
                onLineSelection={onLineSelection}
                commentOpen={commentOpen}
                onCommentOpen={onCommentOpen}
                viewType={viewType}
                ignoreWhitespace={ignoreWhitespace}
                reviewMode={reviewMode}
                draftComments={draftComments?.filter(
                  (d) => d.filePath === file.path
                )}
                onAddDraft={onAddDraft}
                onRemoveDraft={onRemoveDraft}
                onUpdateDraft={onUpdateDraft}
                onStartReview={onStartReview}
                feedbackItems={feedbackItems?.filter(
                  (fi) => fi.filePath === file.path
                )}
                forceLoaded={forceLoadedFiles.has(file.path)}
                onForceLoad={() => onForceLoad(file.path)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function estimateFileDiffHeight(file: DiffFile, collapsed: boolean): number {
  if (collapsed) return DIFF_FILE_MIN_HEIGHT;
  if (file.truncated || !file.diff) return 88;
  const estimated =
    DIFF_FILE_MIN_HEIGHT +
    Math.min(file.added + file.deleted + 12, 38) * DIFF_FILE_LINE_HEIGHT;
  return Math.min(DIFF_FILE_MAX_ESTIMATED_HEIGHT, estimated);
}

type FileDiffSectionProps = {
  agentId: string | null;
  file: DiffFile;
  collapsed: boolean;
  onToggleCollapse: () => void;
  setRef: (el: HTMLDivElement | null) => void;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
  viewType: DiffViewType;
  ignoreWhitespace: boolean;
  reviewMode?: boolean;
  draftComments?: DraftComment[];
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraft?: (id: string) => void;
  onUpdateDraft?: (id: string, comment: string) => void;
  onStartReview?: () => void;
  feedbackItems?: ReviewFeedbackItem[];
  forceLoaded: boolean;
  onForceLoad: () => void;
};

function FileDiffSection({
  agentId,
  file,
  collapsed,
  onToggleCollapse,
  setRef,
  lineSelection,
  onLineSelection,
  commentOpen,
  onCommentOpen,
  viewType,
  ignoreWhitespace,
  reviewMode,
  draftComments,
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
  onStartReview,
  feedbackItems,
  forceLoaded,
  onForceLoad,
}: FileDiffSectionProps): JSX.Element {
  return (
    <div ref={setRef} className="rounded-md border border-border/50">
      <button
        type="button"
        className="sticky top-0 z-10 flex w-full items-center gap-2 rounded-t-md border-b border-border/50 bg-background/95 backdrop-blur-sm px-3 py-2 text-left text-xs hover:bg-muted/60"
        onClick={onToggleCollapse}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {statusIcon(file.status)}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.oldPath ? (
            <>
              <span className="text-muted-foreground">{file.oldPath}</span>
              <span className="text-muted-foreground"> → </span>
            </>
          ) : null}
          {file.path}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          {file.added > 0 ? (
            <span className="text-status-working">+{file.added}</span>
          ) : null}
          {file.deleted > 0 ? (
            <span className="ml-1 text-status-blocked">−{file.deleted}</span>
          ) : null}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <FileDiffContent
              agentId={agentId}
              file={file}
              lineSelection={lineSelection}
              onLineSelection={onLineSelection}
              commentOpen={commentOpen}
              onCommentOpen={onCommentOpen}
              viewType={viewType}
              ignoreWhitespace={ignoreWhitespace}
              reviewMode={reviewMode}
              draftComments={draftComments}
              onAddDraft={onAddDraft}
              onRemoveDraft={onRemoveDraft}
              onUpdateDraft={onUpdateDraft}
              onStartReview={onStartReview}
              feedbackItems={feedbackItems}
              forceLoaded={forceLoaded}
              onForceLoad={onForceLoad}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type FileDiffContentProps = {
  agentId: string | null;
  file: DiffFile;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
  viewType: DiffViewType;
  ignoreWhitespace: boolean;
  reviewMode?: boolean;
  draftComments?: DraftComment[];
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraft?: (id: string) => void;
  onUpdateDraft?: (id: string, comment: string) => void;
  onStartReview?: () => void;
  feedbackItems?: ReviewFeedbackItem[];
  forceLoaded: boolean;
  onForceLoad: () => void;
};

function FileDiffContent({
  agentId,
  file,
  lineSelection,
  onLineSelection,
  commentOpen,
  onCommentOpen,
  viewType,
  ignoreWhitespace,
  reviewMode,
  draftComments,
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
  onStartReview,
  feedbackItems,
  forceLoaded,
  onForceLoad,
}: FileDiffContentProps): JSX.Element {
  const { data: fileDiffData, isLoading: fileDiffLoading } = useAgentFileDiff(
    agentId,
    file.path,
    file.truncated && forceLoaded,
    ignoreWhitespace
  );

  const diffText = file.truncated
    ? forceLoaded
      ? (fileDiffData?.diff ?? null)
      : null
    : file.diff;

  if (file.truncated && !forceLoaded) {
    return (
      <div className="flex items-center justify-between bg-muted/10 px-4 py-3 text-xs text-muted-foreground">
        <span>
          Large file ({file.added > 0 ? `+${file.added}` : ""}
          {file.deleted > 0 ? ` −${file.deleted}` : ""}) — diff truncated
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted/40"
          onClick={onForceLoad}
        >
          Load diff
        </button>
      </div>
    );
  }

  if (file.truncated && forceLoaded && fileDiffLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!diffText) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        {file.status === "deleted"
          ? "File deleted"
          : "Binary file or no textual diff available"}
      </div>
    );
  }

  return (
    <UnifiedDiffView
      agentId={agentId}
      diffText={diffText}
      filePath={file.path}
      lineSelection={
        lineSelection?.filePath === file.path ? lineSelection : null
      }
      onLineSelection={onLineSelection}
      commentOpen={commentOpen}
      onCommentOpen={onCommentOpen}
      viewType={viewType}
      reviewMode={reviewMode}
      draftComments={draftComments}
      onAddDraft={onAddDraft}
      onRemoveDraft={onRemoveDraft}
      onUpdateDraft={onUpdateDraft}
      onStartReview={onStartReview}
      feedbackItems={feedbackItems}
    />
  );
}
