import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  Loader2,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Trash2,
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
import { agentRoute } from "@/lib/agent-routes";
import {
  type DiffViewType,
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffFileTreeOpenAtom,
  diffViewStateAtomFamily,
  reviewDraftAtomFamily,
} from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DraftComment, ReviewModeBar } from "@/components/app/review-mode";
import {
  type ReviewFeedbackItem,
  useAllReviewFeedbackItems,
} from "@/hooks/use-agent-reviews";

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
  onReviewSubmitted?: () => void;
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

  const [searchParams, setSearchParams] = useSearchParams();
  const navFileTarget = searchParams.get("file");

  useEffect(() => {
    if (!navFileTarget || files.length === 0) return;
    const found = files.some((f) => f.path === navFileTarget);
    setSearchParams({}, { replace: true });
    if (found) {
      requestAnimationFrame(() => scrollToFile(navFileTarget));
    }
  }, [navFileTarget, files, scrollToFile, setSearchParams]);

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
          onReviewSubmitted={() => {
            setReviewMode(false);
            onReviewSubmitted?.();
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
          draftComments={draftComments?.filter((d) => d.filePath === file.path)}
          onAddDraft={onAddDraft}
          onRemoveDraft={onRemoveDraft}
          onUpdateDraft={onUpdateDraft}
          onStartReview={onStartReview}
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
              onAddDraft={onAddDraft}
              onRemoveDraft={onRemoveDraft}
              onUpdateDraft={onUpdateDraft}
              onStartReview={onStartReview}
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
      onAddDraft={onAddDraft}
      onRemoveDraft={onRemoveDraft}
      onUpdateDraft={onUpdateDraft}
      onStartReview={onStartReview}
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
  onAddDraft,
  onRemoveDraft,
  onUpdateDraft,
  onStartReview,
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
    const w: Record<string, React.ReactElement> = {};

    // Inline feedback item annotations
    if (feedbackItems) {
      for (const fi of feedbackItems) {
        if (fi.lineStart == null) continue;
        const key = findLastChangeKeyInRange(
          file.hunks,
          fi.lineStart,
          fi.lineEnd ?? fi.lineStart
        );
        if (!key) continue;
        const firstMsg = fi.messages[0]?.content?.body ?? "";
        const isResolved = fi.status === "resolved";
        w[key] = (
          <InlineFeedbackAnnotation
            feedbackItem={fi}
            comment={firstMsg}
            isResolved={isResolved}
          />
        );
      }
    }

    // Draft comment annotations (review mode)
    if (draftComments) {
      for (const draft of draftComments) {
        const key = findLastChangeKeyInRange(
          file.hunks,
          draft.startLine,
          draft.endLine
        );
        if (!key || w[key]) continue;
        w[key] = (
          <InlineDraftAnnotation
            draft={draft}
            onRemove={onRemoveDraft}
            onUpdate={onUpdateDraft}
          />
        );
      }
    }

    // Active comment form (unified split-button: Chat / Start review / Add comment)
    if (lineSelection && agentId && commentOpen) {
      const lastKey = findLastChangeKeyInRange(
        file.hunks,
        lineSelection.startLine,
        lineSelection.endLine
      );
      if (lastKey) {
        w[lastKey] = (
          <InlineCommentForm
            agentId={agentId}
            filePath={filePath}
            startLine={lineSelection.startLine}
            endLine={lineSelection.endLine}
            reviewMode={reviewMode}
            onStartReview={onStartReview}
            onAddDraft={onAddDraft}
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

    return w;
  }, [
    file,
    lineSelection,
    agentId,
    filePath,
    onLineSelection,
    commentOpen,
    onCommentOpen,
    reviewMode,
    onStartReview,
    draftComments,
    onAddDraft,
    onRemoveDraft,
    onUpdateDraft,
    feedbackItems,
  ]);

  const diffRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [buttonPos, setButtonPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) {
        el.style.setProperty("--diff-scroll-w", `${entry.contentRect.width}px`);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-clip [&_.diff-widget-content>*]:max-w-[var(--diff-scroll-w,100%)]"
      >
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
  reviewMode,
  onStartReview,
  onAddDraft,
}: {
  agentId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  onCancel: () => void;
  onSubmitted: () => void;
  reviewMode?: boolean;
  onStartReview?: () => void;
  onAddDraft?: (
    filePath: string,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
}): JSX.Element {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lineLabel =
    startLine === endLine
      ? `Line ${startLine}`
      : `Lines ${startLine}–${endLine}`;

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  const handleChat = useCallback(async () => {
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

  const handleAddDraft = useCallback(() => {
    if (!comment.trim() || !onAddDraft) return;
    onAddDraft(filePath, startLine, endLine, comment.trim());
    onSubmitted();
  }, [comment, filePath, startLine, endLine, onAddDraft, onSubmitted]);

  const handleStartReview = useCallback(() => {
    if (!comment.trim() || !onStartReview || !onAddDraft) return;
    onStartReview();
    onAddDraft(filePath, startLine, endLine, comment.trim());
    onSubmitted();
  }, [
    comment,
    filePath,
    startLine,
    endLine,
    onStartReview,
    onAddDraft,
    onSubmitted,
  ]);

  const handlePrimaryAction = reviewMode ? handleAddDraft : handleStartReview;
  const primaryLabel = reviewMode ? "Add comment" : "Start a review";

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handlePrimaryAction();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handlePrimaryAction, onCancel]
  );

  return (
    <div className="mx-3 my-3 overflow-hidden rounded-md border border-border bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <MessageSquare className="h-3 w-3" />
        <span className="font-medium text-foreground">Add a comment</span>
        <span className="truncate font-mono">{lineLabel}</span>
      </div>
      <div className="p-3">
        <textarea
          ref={textareaRef}
          className="w-full resize-none rounded border border-border bg-muted/20 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Leave a comment…"
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
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <div ref={dropdownRef} className="relative">
            <div className="flex">
              <button
                type="button"
                className="flex items-center gap-1 rounded-l bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={handlePrimaryAction}
                disabled={!comment.trim() || submitting}
              >
                {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {primaryLabel}
              </button>
              <button
                type="button"
                className="flex items-center rounded-r border-l border-primary-foreground/20 bg-primary px-1.5 py-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={() => setDropdownOpen((v) => !v)}
                disabled={!comment.trim() || submitting}
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
            {dropdownOpen && (
              <div className="absolute bottom-full right-0 mb-1 min-w-[140px] rounded border border-border bg-popover py-1 text-xs shadow-md">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40"
                  onClick={() => {
                    setDropdownOpen(false);
                    handleChat();
                  }}
                >
                  <MessageSquare className="h-3 w-3" />
                  Chat
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function InlineFeedbackAnnotation({
  comment,
  isResolved,
  feedbackItem,
}: {
  feedbackItem: ReviewFeedbackItem;
  comment: string;
  isResolved: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(!isResolved);

  const statusLabel = isResolved ? "Resolved" : "Pending";
  const lineLabel =
    feedbackItem.lineStart != null
      ? feedbackItem.lineEnd && feedbackItem.lineEnd !== feedbackItem.lineStart
        ? `Lines ${feedbackItem.lineStart}–${feedbackItem.lineEnd}`
        : `Line ${feedbackItem.lineStart}`
      : null;

  return (
    <div
      className={cn(
        "mx-3 my-3 overflow-hidden rounded-md border bg-background shadow-sm cursor-pointer transition-colors",
        isResolved ? "border-border/50 opacity-60" : "border-amber-500/40"
      )}
      onClick={() => setExpanded((v) => !v)}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[11px]",
          isResolved ? "bg-muted/20" : "bg-amber-500/10"
        )}
      >
        <MessageCircle
          className={cn(
            "h-3 w-3 shrink-0",
            isResolved ? "text-muted-foreground" : "text-amber-500"
          )}
        />
        <span className="font-medium text-foreground">Feedback</span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0 text-[10px] font-medium",
            isResolved
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          )}
        >
          {statusLabel}
        </span>
        {lineLabel && (
          <span className="text-muted-foreground">{lineLabel}</span>
        )}
        {!expanded && (
          <span className="flex-1 truncate text-muted-foreground">
            {comment}
          </span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="feedback-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-3 py-2">
              <p className="whitespace-pre-wrap text-xs text-foreground/80">
                {comment}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function InlineDraftAnnotation({
  draft,
  onRemove,
  onUpdate,
}: {
  draft: DraftComment;
  onRemove?: (id: string) => void;
  onUpdate?: (id: string, comment: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(draft.comment);

  const handleSave = useCallback(() => {
    if (editValue.trim() && onUpdate) {
      onUpdate(draft.id, editValue.trim());
    }
    setEditing(false);
  }, [draft.id, editValue, onUpdate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditValue(draft.comment);
        setEditing(false);
      }
    },
    [handleSave, draft.comment]
  );

  const lineLabel =
    draft.startLine === draft.endLine
      ? `Line ${draft.startLine}`
      : `Lines ${draft.startLine}–${draft.endLine}`;

  if (editing) {
    return (
      <div className="mx-3 my-3 overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm">
        <div className="flex items-center gap-2 border-b border-border/50 bg-primary/10 px-3 py-2 text-[11px]">
          <MessageSquarePlus className="h-3 w-3 text-primary" />
          <span className="font-medium text-foreground">Edit draft</span>
        </div>
        <div className="p-3">
          <textarea
            className="w-full resize-none rounded border border-border bg-muted/20 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            rows={3}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={handleSave}
              disabled={!editValue.trim()}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-3 my-3 overflow-hidden rounded-md border border-primary/40 bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/50 bg-primary/10 px-3 py-2 text-[11px]">
        <MessageSquarePlus className="h-3 w-3 text-primary" />
        <span className="font-medium text-foreground">Draft</span>
        <span className="rounded-full bg-amber-500/15 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          Pending
        </span>
        <span className="text-muted-foreground">{lineLabel}</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[120px]">
            <DropdownMenuItem
              className="text-foreground"
              onClick={() => {
                setEditValue(draft.comment);
                setEditing(true);
              }}
            >
              <Pencil className="mr-2 h-3 w-3" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRemove?.(draft.id)}>
              <Trash2 className="mr-2 h-3 w-3" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 py-2">
        <p className="whitespace-pre-wrap text-xs text-foreground/80">
          {draft.comment}
        </p>
      </div>
    </div>
  );
}
