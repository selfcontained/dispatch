import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  Pencil,
  Send,
  Trash2,
  User,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Diff,
  Hunk,
  markEdits,
  parseDiff,
  tokenize,
  getChangeKey,
  type ChangeData,
  type HunkData,
  type EventMap,
} from "react-diff-view";
import "react-diff-view/style/index.css";
import { refractor as baseRefractor } from "refractor";
import jsx from "refractor/jsx";
import tsx from "refractor/tsx";
import scss from "refractor/scss";
import toml from "refractor/toml";
import diff from "refractor/diff";
import docker from "refractor/docker";
import graphql from "refractor/graphql";
import elixir from "refractor/elixir";
import haskell from "refractor/haskell";
import lua from "refractor/lua";
import php from "refractor/php";
import scala from "refractor/scala";
import dart from "refractor/dart";
import r from "refractor/r";
import perl from "refractor/perl";
import zig from "refractor/zig";
import nim from "refractor/nim";
import objectivec from "refractor/objectivec";
import shell from "refractor/shell-session";

baseRefractor.register(jsx);
baseRefractor.register(tsx);
baseRefractor.register(scss);
baseRefractor.register(toml);
baseRefractor.register(diff);
baseRefractor.register(docker);
baseRefractor.register(graphql);
baseRefractor.register(elixir);
baseRefractor.register(haskell);
baseRefractor.register(lua);
baseRefractor.register(php);
baseRefractor.register(scala);
baseRefractor.register(dart);
baseRefractor.register(r);
baseRefractor.register(perl);
baseRefractor.register(zig);
baseRefractor.register(nim);
baseRefractor.register(objectivec);
baseRefractor.register(shell);

const refractorAdapter = {
  highlight(code: string, language: string) {
    const root = baseRefractor.highlight(code, language);
    return root.children;
  },
  registered(language: string) {
    return baseRefractor.registered(language);
  },
};

import {
  useAgentDiff,
  useAgentFileDiff,
  type DiffFile,
  type DiffFileStatus,
} from "@/hooks/use-agent-diff";
import {
  useSubmitReview,
  useAgentFeedbackItems,
  type FeedbackItemAnnotation,
} from "@/hooks/use-agent-reviews";
import { agentRoute } from "@/lib/agent-routes";
import {
  type DiffViewType,
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffFileTreeOpenAtom,
  diffViewStateAtomFamily,
} from "@/lib/store";
import { cn } from "@/lib/utils";
import type { DraftReviewComment } from "@/components/app/types";

type LineSelection = {
  filePath: string;
  startLine: number;
  endLine: number;
  anchorLine: number;
};

type ChangesTabProps = {
  agentId: string | null;
  active: boolean;
  isMobile?: boolean;
};

export const ChangesTab = memo(function ChangesTab({
  agentId,
  active,
  isMobile,
}: ChangesTabProps): JSX.Element {
  const storedViewType = useAtomValue(diffViewTypeAtom);
  const viewType = isMobile ? "unified" : storedViewType;
  const ignoreWhitespace = useAtomValue(diffIgnoreWhitespaceAtom);
  const { data, isLoading } = useAgentDiff(agentId, active, ignoreWhitespace);
  const [viewState, setViewState] = useAtom(
    diffViewStateAtomFamily(agentId ?? "")
  );

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

  // Review mode state
  const [reviewMode, setReviewMode] = useState(false);
  const [draftComments, setDraftComments] = useState<DraftReviewComment[]>([]);
  const [reviewSummary, setReviewSummary] = useState("");
  const [showSubmitPanel, setShowSubmitPanel] = useState(false);
  const submitReview = useSubmitReview(agentId);

  // Fetch persisted feedback items for inline annotations
  const { data: feedbackItems } = useAgentFeedbackItems(agentId, active);

  const addDraftComment = useCallback(
    (filePath: string, startLine: number, endLine: number, comment: string) => {
      setDraftComments((prev) => [
        ...prev,
        {
          id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          filePath,
          startLine,
          endLine,
          comment,
        },
      ]);
    },
    []
  );

  const removeDraftComment = useCallback((id: string) => {
    setDraftComments((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const updateDraftComment = useCallback((id: string, comment: string) => {
    setDraftComments((prev) =>
      prev.map((d) => (d.id === id ? { ...d, comment } : d))
    );
  }, []);

  const handleSubmitReview = useCallback(async () => {
    if (draftComments.length === 0) return;
    try {
      await submitReview.mutateAsync({
        summary: reviewSummary.trim() || undefined,
        items: draftComments.map((d) => ({
          filePath: d.filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          comment: d.comment,
        })),
      });
      // Clear review state on success
      setReviewMode(false);
      setDraftComments([]);
      setReviewSummary("");
      setShowSubmitPanel(false);
    } catch {
      // Error is handled by the mutation
    }
  }, [draftComments, reviewSummary, submitReview]);

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
      {/* Review mode toolbar */}
      {agentId ? (
        <ReviewToolbar
          reviewMode={reviewMode}
          draftCount={draftComments.length}
          submitting={submitReview.isPending}
          onStartReview={() => {
            setReviewMode(true);
            setShowSubmitPanel(false);
          }}
          onCancelReview={() => {
            setReviewMode(false);
            setDraftComments([]);
            setReviewSummary("");
            setShowSubmitPanel(false);
          }}
          onToggleSubmitPanel={() => setShowSubmitPanel((v) => !v)}
        />
      ) : null}

      {/* Submit review panel */}
      <AnimatePresence>
        {showSubmitPanel && reviewMode && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-b border-border/50"
          >
            <SubmitReviewPanel
              summary={reviewSummary}
              onSummaryChange={setReviewSummary}
              draftComments={draftComments}
              onRemoveDraft={removeDraftComment}
              onSubmit={handleSubmitReview}
              submitting={submitReview.isPending}
              error={submitReview.error?.message ?? null}
            />
          </motion.div>
        )}
      </AnimatePresence>

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
          onAddDraftComment={addDraftComment}
          onRemoveDraftComment={removeDraftComment}
          onUpdateDraftComment={updateDraftComment}
          feedbackItems={feedbackItems}
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
  reviewMode: boolean;
  draftComments: DraftReviewComment[];
  onAddDraftComment: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraftComment: (id: string) => void;
  onUpdateDraftComment: (id: string, comment: string) => void;
  feedbackItems?: FeedbackItemAnnotation[];
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
  onAddDraftComment,
  onRemoveDraftComment,
  onUpdateDraftComment,
  feedbackItems,
}: DiffPaneProps): JSX.Element {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-background px-3 pb-3"
    >
      {files.map((file) => (
        <FileDiffSection
          key={file.path}
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
          draftComments={draftComments.filter((d) => d.filePath === file.path)}
          onAddDraftComment={onAddDraftComment}
          onRemoveDraftComment={onRemoveDraftComment}
          onUpdateDraftComment={onUpdateDraftComment}
          feedbackItems={feedbackItems?.filter(
            (fi) => fi.filePath === file.path
          )}
        />
      ))}
    </div>
  );
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
  reviewMode: boolean;
  draftComments: DraftReviewComment[];
  onAddDraftComment: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraftComment: (id: string) => void;
  onUpdateDraftComment: (id: string, comment: string) => void;
  feedbackItems?: FeedbackItemAnnotation[];
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
  onAddDraftComment,
  onRemoveDraftComment,
  onUpdateDraftComment,
  feedbackItems,
}: FileDiffSectionProps): JSX.Element {
  return (
    <div ref={setRef} className="rounded-md border border-border/50">
      <button
        type="button"
        className="sticky top-0 z-10 flex w-full items-center gap-2 rounded-t-md border-b border-border/50 bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/60"
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
              onAddDraftComment={onAddDraftComment}
              onRemoveDraftComment={onRemoveDraftComment}
              onUpdateDraftComment={onUpdateDraftComment}
              feedbackItems={feedbackItems}
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
  reviewMode: boolean;
  draftComments: DraftReviewComment[];
  onAddDraftComment: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraftComment: (id: string) => void;
  onUpdateDraftComment: (id: string, comment: string) => void;
  feedbackItems?: FeedbackItemAnnotation[];
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
  onAddDraftComment,
  onRemoveDraftComment,
  onUpdateDraftComment,
  feedbackItems,
}: FileDiffContentProps): JSX.Element {
  const [forceLoad, setForceLoad] = useState(false);
  const { data: fileDiffData, isLoading: fileDiffLoading } = useAgentFileDiff(
    agentId,
    file.path,
    file.truncated && forceLoad,
    ignoreWhitespace
  );

  const diffText = file.truncated
    ? forceLoad
      ? (fileDiffData?.diff ?? null)
      : null
    : file.diff;

  if (file.truncated && !forceLoad) {
    return (
      <div className="flex items-center justify-between bg-muted/10 px-4 py-3 text-xs text-muted-foreground">
        <span>
          Large file ({file.added > 0 ? `+${file.added}` : ""}
          {file.deleted > 0 ? ` −${file.deleted}` : ""}) — diff truncated
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted/40"
          onClick={() => setForceLoad(true)}
        >
          Load diff
        </button>
      </div>
    );
  }

  if (file.truncated && forceLoad && fileDiffLoading) {
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
      onAddDraftComment={onAddDraftComment}
      onRemoveDraftComment={onRemoveDraftComment}
      onUpdateDraftComment={onUpdateDraftComment}
      feedbackItems={feedbackItems}
    />
  );
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  html: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  swift: "swift",
  kt: "kotlin",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "docker",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  lua: "lua",
  php: "php",
  scala: "scala",
  dart: "dart",
  r: "r",
  pl: "perl",
  pm: "perl",
  zig: "zig",
  nim: "nim",
  m: "objectivec",
};

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "makefile",
};

function languageFromPath(filePath: string): string | null {
  const basename = filePath.split("/").pop() ?? "";
  const byName = FILENAME_TO_LANGUAGE[basename];
  if (byName && refractorAdapter.registered(byName)) return byName;

  const ext = basename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  const lang = EXT_TO_LANGUAGE[ext];
  if (!lang) return null;
  if (!refractorAdapter.registered(lang)) return null;
  return lang;
}

function getNewLineNumber(change: ChangeData): number | null {
  if (change.type === "insert") return change.lineNumber;
  if (change.type === "normal") return change.newLineNumber;
  return null;
}

function collectSelectedChangeKeys(
  hunks: HunkData[],
  startLine: number,
  endLine: number
): string[] {
  const keys: string[] = [];
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const ln = getNewLineNumber(change);
      if (ln !== null && ln >= startLine && ln <= endLine) {
        keys.push(getChangeKey(change));
      }
    }
  }
  return keys;
}

function findLastChangeKeyInRange(
  hunks: HunkData[],
  startLine: number,
  endLine: number
): string | null {
  let lastKey: string | null = null;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const ln = getNewLineNumber(change);
      if (ln !== null && ln >= startLine && ln <= endLine) {
        lastKey = getChangeKey(change);
      }
    }
  }
  return lastKey;
}

type UnifiedDiffViewProps = {
  agentId: string | null;
  diffText: string;
  filePath: string;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
  viewType: DiffViewType;
  reviewMode: boolean;
  draftComments: DraftReviewComment[];
  onAddDraftComment: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onRemoveDraftComment: (id: string) => void;
  onUpdateDraftComment: (id: string, comment: string) => void;
  feedbackItems?: FeedbackItemAnnotation[];
};

const UnifiedDiffView = memo(function UnifiedDiffView({
  agentId,
  diffText,
  filePath,
  lineSelection,
  onLineSelection,
  commentOpen,
  onCommentOpen,
  viewType,
  reviewMode,
  draftComments,
  onAddDraftComment,
  onRemoveDraftComment,
  onUpdateDraftComment,
  feedbackItems,
}: UnifiedDiffViewProps): JSX.Element {
  const parsed = useMemo(() => {
    try {
      return parseDiff(diffText, { nearbySequences: "zip" });
    } catch {
      return [];
    }
  }, [diffText]);

  const language = useMemo(() => languageFromPath(filePath), [filePath]);

  const tokens = useMemo(() => {
    if (parsed.length === 0) return undefined;
    const file = parsed[0]!;
    const enhancers = [markEdits(file.hunks)];
    try {
      if (language) {
        return tokenize(file.hunks, {
          highlight: true,
          refractor: refractorAdapter,
          language,
          enhancers,
        });
      }
      return tokenize(file.hunks, { enhancers });
    } catch {
      return undefined;
    }
  }, [parsed, language]);

  const gutterEvents: EventMap = useMemo(
    () => ({
      onClick: ({ change }, e) => {
        if (!change) return;
        const ln = getNewLineNumber(change);
        if (ln === null) return;

        const mouseEvent = e as unknown as MouseEvent;

        if (mouseEvent.shiftKey && lineSelection) {
          const start = Math.min(lineSelection.anchorLine, ln);
          const end = Math.max(lineSelection.anchorLine, ln);
          onLineSelection({
            filePath,
            startLine: start,
            endLine: end,
            anchorLine: lineSelection.anchorLine,
          });
        } else if (
          lineSelection &&
          ln >= lineSelection.startLine &&
          ln <= lineSelection.endLine
        ) {
          onLineSelection(null);
        } else {
          onLineSelection({
            filePath,
            startLine: ln,
            endLine: ln,
            anchorLine: ln,
          });
        }
      },
    }),
    [filePath, lineSelection, onLineSelection]
  );

  const file = parsed.length > 0 ? parsed[0]! : null;

  const selectedChanges = useMemo(() => {
    if (!file || !lineSelection) return [];
    return collectSelectedChangeKeys(
      file.hunks,
      lineSelection.startLine,
      lineSelection.endLine
    );
  }, [file, lineSelection]);

  const widgets = useMemo(() => {
    if (!file) return {};
    const result: Record<string, React.ReactNode> = {};

    // Add draft comment widgets (review mode)
    for (const draft of draftComments) {
      const lastKey = findLastChangeKeyInRange(
        file.hunks,
        draft.startLine,
        draft.endLine
      );
      if (lastKey) {
        result[lastKey] = (
          <DraftCommentWidget
            key={draft.id}
            draft={draft}
            onRemove={() => onRemoveDraftComment(draft.id)}
            onUpdate={(comment) => onUpdateDraftComment(draft.id, comment)}
          />
        );
      }
    }

    // Add persisted feedback item annotations
    if (feedbackItems) {
      for (const fi of feedbackItems) {
        if (fi.lineStart == null) continue;
        const lastKey = findLastChangeKeyInRange(
          file.hunks,
          fi.lineStart,
          fi.lineEnd ?? fi.lineStart
        );
        if (lastKey && !result[lastKey]) {
          result[lastKey] = <FeedbackAnnotationWidget key={fi.id} item={fi} />;
        }
      }
    }

    // Add quick comment / review draft form widget
    if (lineSelection && agentId && commentOpen) {
      const lastKey = findLastChangeKeyInRange(
        file.hunks,
        lineSelection.startLine,
        lineSelection.endLine
      );
      if (lastKey && !result[lastKey]) {
        if (reviewMode) {
          result[lastKey] = (
            <ReviewDraftCommentForm
              filePath={filePath}
              startLine={lineSelection.startLine}
              endLine={lineSelection.endLine}
              onCancel={() => {
                onCommentOpen(false);
                onLineSelection(null);
              }}
              onAdd={(comment) => {
                onAddDraftComment(
                  filePath,
                  lineSelection.startLine,
                  lineSelection.endLine,
                  comment
                );
                onCommentOpen(false);
                onLineSelection(null);
              }}
            />
          );
        } else {
          result[lastKey] = (
            <InlineCommentForm
              agentId={agentId}
              filePath={filePath}
              startLine={lineSelection.startLine}
              endLine={lineSelection.endLine}
              onCancel={() => {
                onCommentOpen(false);
                onLineSelection(null);
              }}
              onSubmitted={() => {
                onCommentOpen(false);
                onLineSelection(null);
              }}
            />
          );
        }
      }
    }

    return result;
  }, [
    file,
    lineSelection,
    agentId,
    filePath,
    onLineSelection,
    commentOpen,
    onCommentOpen,
    reviewMode,
    draftComments,
    onAddDraftComment,
    onRemoveDraftComment,
    onUpdateDraftComment,
    feedbackItems,
  ]);

  const diffRef = useRef<HTMLDivElement>(null);
  const [buttonPos, setButtonPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!lineSelection || commentOpen || !diffRef.current) {
      setButtonPos(null);
      return;
    }
    const container = diffRef.current;
    const allSelected = container.querySelectorAll(".diff-gutter-selected");
    if (allSelected.length === 0) {
      setButtonPos(null);
      return;
    }
    // Each row has two gutter cells with the class; pick the first per row
    const firstGutters: Element[] = [];
    for (const el of allSelected) {
      const tr = el.closest("tr");
      if (tr && el === tr.querySelector(".diff-gutter-selected")) {
        firstGutters.push(el);
      }
    }
    if (firstGutters.length === 0) {
      setButtonPos(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const firstRect = firstGutters[0]!.getBoundingClientRect();
    const lastRect =
      firstGutters[firstGutters.length - 1]!.getBoundingClientRect();
    const centerY = (firstRect.top + lastRect.bottom) / 2 - containerRect.top;
    const gutterLeft = firstRect.left - containerRect.left;
    setButtonPos({ top: centerY, left: gutterLeft, width: firstRect.width });
  }, [lineSelection, commentOpen, selectedChanges]);

  if (!file) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        Unable to parse diff
      </div>
    );
  }

  const diffType =
    file.type === "add"
      ? "add"
      : file.type === "delete"
        ? "delete"
        : file.type === "rename"
          ? "rename"
          : "modify";

  return (
    <div
      ref={diffRef}
      className={cn(
        "changes-diff-view text-xs relative",
        "[&_.diff.diff-split]:table-fixed [&_.diff.diff-split]:w-full",
        "[&_.diff.diff-split_.diff-gutter-col]:w-10",
        "[&_.diff.diff-split_.diff-gutter]:px-1 [&_.diff.diff-split_.diff-gutter]:py-0",
        "[&_.diff.diff-split_.diff-code]:px-2 [&_.diff.diff-split_.diff-code]:py-0 [&_.diff.diff-split_.diff-code]:whitespace-pre-wrap [&_.diff.diff-split_.diff-code]:break-words"
      )}
    >
      <div className="overflow-x-auto overflow-y-clip">
        <Diff
          viewType={viewType}
          diffType={diffType}
          hunks={file.hunks}
          tokens={tokens}
          gutterEvents={gutterEvents}
          selectedChanges={selectedChanges}
          widgets={widgets}
        >
          {(hunks) =>
            hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)
          }
        </Diff>
      </div>
      {buttonPos !== null && !commentOpen && lineSelection && (
        <button
          type="button"
          onClick={() => onCommentOpen(true)}
          className="absolute z-10 flex items-center justify-center rounded-md bg-primary p-1 text-primary-foreground shadow-md hover:bg-primary/90 -translate-y-1/2"
          style={{
            top: buttonPos.top,
            left: buttonPos.left + buttonPos.width / 2,
            transform: "translate(-50%, -50%)",
          }}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
});

function InlineCommentForm({
  agentId,
  filePath,
  startLine,
  endLine,
  onCancel,
  onSubmitted,
}: {
  agentId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  onCancel: () => void;
  onSubmitted: () => void;
}): JSX.Element {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lineLabel =
    startLine === endLine
      ? `Line ${startLine}`
      : `Lines ${startLine}–${endLine}`;

  const handleSubmit = useCallback(async () => {
    if (!comment.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/agents/${agentId}/diff/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, startLine, endLine, comment }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? "Failed to send comment");
      }
      onSubmitted();
      navigate(agentRoute(agentId), { replace: true });
    } catch {
      setSubmitting(false);
    }
  }, [
    agentId,
    comment,
    endLine,
    filePath,
    navigate,
    onSubmitted,
    startLine,
    submitting,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel]
  );

  return (
    <div className="border-t border-border/50 bg-muted/20 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <MessageSquare className="h-3 w-3" />
        <span className="font-mono">{filePath}</span>
        <span>·</span>
        <span>{lineLabel}</span>
      </div>
      <textarea
        ref={textareaRef}
        className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Leave a comment for the agent…"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        disabled={submitting}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
          onClick={onCancel}
          disabled={submitting}
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={handleSubmit}
          disabled={!comment.trim() || submitting}
        >
          {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
          Chat Now
        </button>
      </div>
    </div>
  );
}

// --- Review Mode Components ---

function ReviewToolbar({
  reviewMode,
  draftCount,
  submitting,
  onStartReview,
  onCancelReview,
  onToggleSubmitPanel,
}: {
  reviewMode: boolean;
  draftCount: number;
  submitting: boolean;
  onStartReview: () => void;
  onCancelReview: () => void;
  onToggleSubmitPanel: () => void;
}): JSX.Element {
  if (!reviewMode) {
    return (
      <div className="flex shrink-0 items-center justify-end border-b border-border/50 bg-muted/20 px-3 py-1.5">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
          onClick={onStartReview}
        >
          <Pencil className="h-3 w-3" />
          Start Review
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/5 px-3 py-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
        <Pencil className="h-3 w-3" />
        Review Mode
      </div>
      {draftCount > 0 ? (
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
          {draftCount} comment{draftCount !== 1 ? "s" : ""}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          Click line numbers to add comments
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
          onClick={onCancelReview}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
            draftCount > 0
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          )}
          onClick={onToggleSubmitPanel}
          disabled={draftCount === 0 || submitting}
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          Submit Review
        </button>
      </div>
    </div>
  );
}

function SubmitReviewPanel({
  summary,
  onSummaryChange,
  draftComments,
  onRemoveDraft,
  onSubmit,
  submitting,
  error,
}: {
  summary: string;
  onSummaryChange: (v: string) => void;
  draftComments: DraftReviewComment[];
  onRemoveDraft: (id: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
}): JSX.Element {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit]
  );

  return (
    <div className="bg-muted/10 p-4">
      <div className="mb-3">
        <label className="mb-1.5 block text-xs font-medium text-foreground">
          Review Summary (optional)
        </label>
        <textarea
          className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Overall feedback or context for this review…"
          rows={2}
          value={summary}
          onChange={(e) => onSummaryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={submitting}
        />
      </div>

      <div className="mb-3">
        <div className="mb-1.5 text-xs font-medium text-foreground">
          Feedback Items ({draftComments.length})
        </div>
        <div className="max-h-40 space-y-1.5 overflow-y-auto">
          {draftComments.map((draft, i) => {
            const lineRef =
              draft.startLine === draft.endLine
                ? `:${draft.startLine}`
                : `:${draft.startLine}-${draft.endLine}`;
            return (
              <div
                key={draft.id}
                className="flex items-start gap-2 rounded bg-background/60 px-2.5 py-1.5 text-xs"
              >
                <span className="shrink-0 text-muted-foreground">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {draft.filePath}
                    {lineRef}
                  </span>
                  <p className="mt-0.5 truncate text-foreground">
                    {draft.comment}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  onClick={() => onRemoveDraft(draft.id)}
                  title="Remove"
                  disabled={submitting}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {error ? (
        <div className="mb-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={onSubmit}
          disabled={draftComments.length === 0 || submitting}
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          Submit Review ({draftComments.length} item
          {draftComments.length !== 1 ? "s" : ""})
        </button>
      </div>
    </div>
  );
}

function ReviewDraftCommentForm({
  filePath,
  startLine,
  endLine,
  onCancel,
  onAdd,
}: {
  filePath: string;
  startLine: number;
  endLine: number;
  onCancel: () => void;
  onAdd: (comment: string) => void;
}): JSX.Element {
  const [comment, setComment] = useState("");

  const lineLabel =
    startLine === endLine
      ? `Line ${startLine}`
      : `Lines ${startLine}–${endLine}`;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (comment.trim()) onAdd(comment.trim());
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [comment, onAdd, onCancel]
  );

  return (
    <div className="border-t border-primary/30 bg-primary/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Pencil className="h-3 w-3 text-primary" />
        <span className="font-mono">{filePath}</span>
        <span>·</span>
        <span>{lineLabel}</span>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          Draft
        </span>
      </div>
      <textarea
        className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Add a review comment…"
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
          onClick={onCancel}
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={() => {
            if (comment.trim()) onAdd(comment.trim());
          }}
          disabled={!comment.trim()}
        >
          <Pencil className="h-3 w-3" />
          Add to Review
        </button>
      </div>
    </div>
  );
}

function DraftCommentWidget({
  draft,
  onRemove,
  onUpdate,
}: {
  draft: DraftReviewComment;
  onRemove: () => void;
  onUpdate: (comment: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.comment);

  const lineLabel =
    draft.startLine === draft.endLine
      ? `Line ${draft.startLine}`
      : `Lines ${draft.startLine}–${draft.endLine}`;

  const handleSaveEdit = useCallback(() => {
    if (editText.trim()) {
      onUpdate(editText.trim());
      setEditing(false);
    }
  }, [editText, onUpdate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSaveEdit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditing(false);
        setEditText(draft.comment);
      }
    },
    [handleSaveEdit, draft.comment]
  );

  return (
    <div className="border-t border-primary/30 bg-primary/5 px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <Pencil className="h-3 w-3 text-primary" />
        <span className="font-mono text-muted-foreground">{lineLabel}</span>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          Draft
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!editing && (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => {
                setEditing(true);
                setEditText(draft.comment);
              }}
              title="Edit"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
            title="Remove"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            rows={3}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => {
                setEditing(false);
                setEditText(draft.comment);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={handleSaveEdit}
              disabled={!editText.trim()}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap text-xs text-foreground">
          {draft.comment}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline annotation for persisted review feedback items
// ---------------------------------------------------------------------------

function FeedbackAnnotationWidget({
  item,
}: {
  item: FeedbackItemAnnotation;
}): JSX.Element {
  const [expanded, setExpanded] = useState(item.status !== "resolved");
  const isResolved = item.status === "resolved";

  const lineLabel =
    item.lineStart != null
      ? item.lineEnd != null && item.lineEnd !== item.lineStart
        ? `Lines ${item.lineStart}-${item.lineEnd}`
        : `Line ${item.lineStart}`
      : "General";

  const StatusIcon =
    item.status === "resolved"
      ? CheckCircle2
      : item.status === "in_progress"
        ? Clock
        : Circle;

  const statusColor =
    item.status === "resolved"
      ? "text-status-working"
      : item.status === "in_progress"
        ? "text-primary"
        : "text-status-waiting";

  const statusLabel =
    item.status === "resolved"
      ? "Resolved"
      : item.status === "in_progress"
        ? "In progress"
        : "Open";

  return (
    <div
      className={cn(
        "border-t border-border/50",
        isResolved ? "bg-muted/10 opacity-60" : "bg-muted/20"
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[11px] hover:bg-muted/30"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon className={cn("h-3 w-3 shrink-0", statusColor)} />
        <span className={cn("text-[10px] font-medium uppercase", statusColor)}>
          {statusLabel}
        </span>
        <span className="font-mono text-muted-foreground">{lineLabel}</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
          {item.reviewerType === "human" ? (
            <User className="h-2.5 w-2.5" />
          ) : (
            <Bot className="h-2.5 w-2.5" />
          )}
          {item.reviewerType === "human" ? "Human" : "Agent"}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="annotation-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-2.5">
              {item.firstMessage ? (
                <p className="whitespace-pre-wrap text-xs text-foreground/80">
                  {item.firstMessage.content.body}
                </p>
              ) : null}
              {isResolved && item.resolution ? (
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-status-working">
                  <CheckCircle2 className="h-3 w-3" />
                  <span className="capitalize">
                    {item.resolution.replace("_", " ")}
                  </span>
                  {item.resolutionNote ? (
                    <span className="text-muted-foreground">
                      {" "}
                      -- {item.resolutionNote}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
