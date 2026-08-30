import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileImage,
  FileMinus,
  FilePlus,
  FileText,
  Loader2,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { useAgentFileDiff, type DiffFile } from "@/hooks/use-agent-diff";
import type { DiffViewType } from "@/lib/store";
import type { DiffReviewAnnotationProps } from "@/components/app/diff-review-annotation-props";
import { DiffImageView } from "@/components/app/diff-image-view";
import { UnifiedDiffView } from "@/components/app/unified-diff-view";
import { type LineSelection } from "@/components/app/unified-diff-utils";

function statusIcon(file: DiffFile): JSX.Element {
  if (file.image) {
    return <FileImage className="h-3.5 w-3.5 text-muted-foreground" />;
  }
  switch (file.status) {
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

type DiffPaneProps = DiffReviewAnnotationProps & {
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
};

export function DiffPane({
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
  focusedFeedbackItemId,
  onFeedbackFocusComplete,
}: DiffPaneProps): JSX.Element {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="changes-diff-pane"
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
          focusedFeedbackItemId={focusedFeedbackItemId}
          onFeedbackFocusComplete={onFeedbackFocusComplete}
        />
      ))}
    </div>
  );
}

type FileDiffSectionProps = DiffReviewAnnotationProps & {
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
  focusedFeedbackItemId,
  onFeedbackFocusComplete,
}: FileDiffSectionProps): JSX.Element {
  return (
    <div
      ref={setRef}
      data-testid={`changes-file-section:${file.path}`}
      className="rounded-md border border-border/50"
    >
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
        {statusIcon(file)}
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
              focusedFeedbackItemId={focusedFeedbackItemId}
              onFeedbackFocusComplete={onFeedbackFocusComplete}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type FileDiffContentProps = DiffReviewAnnotationProps & {
  agentId: string | null;
  file: DiffFile;
  lineSelection: LineSelection | null;
  onLineSelection: (sel: LineSelection | null) => void;
  commentOpen: boolean;
  onCommentOpen: (open: boolean) => void;
  viewType: DiffViewType;
  ignoreWhitespace: boolean;
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
  focusedFeedbackItemId,
  onFeedbackFocusComplete,
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

  // Images come before the diff-text check: git emits a "Binary files differ"
  // stub for a tracked image, which is truthy but has no hunks to render.
  if (file.image) {
    return (
      <DiffImageView
        agentId={agentId}
        filePath={file.path}
        oldPath={file.oldPath}
        status={file.status}
        image={file.image}
      />
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
      focusedFeedbackItemId={focusedFeedbackItemId}
      onFeedbackFocusComplete={onFeedbackFocusComplete}
    />
  );
}
