import { memo, useCallback, useMemo, useRef, useState } from "react";
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
import { agentRoute } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

type LineSelection = {
  filePath: string;
  startLine: number;
  endLine: number;
  anchorLine: number;
};

type ChangesTabProps = {
  agentId: string | null;
  active: boolean;
};

export const ChangesTab = memo(function ChangesTab({
  agentId,
  active,
}: ChangesTabProps): JSX.Element {
  const { data, isLoading } = useAgentDiff(agentId, active);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showFileTree, setShowFileTree] = useState(true);
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(
    null
  );
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const files = useMemo(
    () => [...(data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    [data?.files]
  );

  const scrollToFile = useCallback((path: string) => {
    setSelectedFile(path);
    const el = fileRefs.current.get(path);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setCollapsedFiles((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

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
    <div className="flex h-full min-h-0">
      {showFileTree && (
        <FileTree
          files={files}
          selectedFile={selectedFile}
          onSelectFile={scrollToFile}
          onClose={() => setShowFileTree(false)}
        />
      )}
      <DiffPane
        agentId={agentId}
        files={files}
        collapsedFiles={collapsedFiles}
        showFileTreeToggle={!showFileTree}
        onShowFileTree={() => setShowFileTree(true)}
        onToggleCollapse={(path) => {
          setCollapsedFiles((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
              next.delete(path);
            } else {
              next.add(path);
            }
            return next;
          });
        }}
        fileRefs={fileRefs}
        lineSelection={lineSelection}
        onLineSelection={setLineSelection}
      />
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
  onClose: () => void;
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
  onClose,
}: FileTreeProps): JSX.Element {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border/50 bg-muted/20">
      <div className="flex shrink-0 items-center justify-between border-b border-border/40 bg-muted/30 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {files.length} file{files.length !== 1 ? "s" : ""} changed
        </span>
        <button
          type="button"
          onClick={onClose}
          className="min-h-7 min-w-7 rounded p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          title="Hide file tree"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {(tree.file ? [tree] : [...tree.children.values()]).map((child) => (
          <TreeEntry
            key={child.path}
            node={child}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            collapsedDirs={collapsedDirs}
            onToggleDir={toggleDir}
          />
        ))}
      </div>
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
  showFileTreeToggle: boolean;
  onShowFileTree: () => void;
  onToggleCollapse: (path: string) => void;
  fileRefs: React.RefObject<Map<string, HTMLDivElement> | null>;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
};

function DiffPane({
  agentId,
  files,
  collapsedFiles,
  showFileTreeToggle,
  onShowFileTree,
  onToggleCollapse,
  fileRefs,
  lineSelection,
  onLineSelection,
}: DiffPaneProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showFileTreeToggle && (
        <div className="shrink-0 border-b border-border/40 bg-muted/20 px-2 py-1">
          <button
            type="button"
            onClick={onShowFileTree}
            className="min-h-7 min-w-7 rounded border border-border/50 bg-muted/60 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Show file tree"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-background px-3 pb-3">
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
          />
        ))}
      </div>
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
};

function FileDiffSection({
  agentId,
  file,
  collapsed,
  onToggleCollapse,
  setRef,
  lineSelection,
  onLineSelection,
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
};

function FileDiffContent({
  agentId,
  file,
  lineSelection,
  onLineSelection,
}: FileDiffContentProps): JSX.Element {
  const [forceLoad, setForceLoad] = useState(false);
  const { data: fileDiffData, isLoading: fileDiffLoading } = useAgentFileDiff(
    agentId,
    file.path,
    file.truncated && forceLoad
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
};

const UnifiedDiffView = memo(function UnifiedDiffView({
  agentId,
  diffText,
  filePath,
  lineSelection,
  onLineSelection,
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
    if (!file || !lineSelection || !agentId) return {};
    const lastKey = findLastChangeKeyInRange(
      file.hunks,
      lineSelection.startLine,
      lineSelection.endLine
    );
    if (!lastKey) return {};
    return {
      [lastKey]: (
        <InlineCommentForm
          agentId={agentId}
          filePath={filePath}
          startLine={lineSelection.startLine}
          endLine={lineSelection.endLine}
          onCancel={() => onLineSelection(null)}
          onSubmitted={() => onLineSelection(null)}
        />
      ),
    };
  }, [file, lineSelection, agentId, filePath, onLineSelection]);

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
    <div className="changes-diff-view overflow-x-auto text-xs">
      <Diff
        viewType="unified"
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
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          Send
        </button>
      </div>
    </div>
  );
}
