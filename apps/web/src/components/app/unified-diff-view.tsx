import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Decoration,
  Diff,
  Hunk,
  parseDiff,
  type EventMap,
} from "react-diff-view";
import "react-diff-view/style/index.css";
import { MessageSquare } from "lucide-react";

import { type DiffViewType } from "@/lib/store";
import { cn } from "@/lib/utils";
import { type DraftComment } from "@/components/app/review-mode";
import {
  languageFromPath,
  refractorAdapter,
} from "@/components/app/unified-diff-language";
import {
  collectSelectedChangeKeys,
  getNewLineNumber,
  parseHunkHeader,
  tokenizeHunksIndependently,
  type LineSelection,
} from "@/components/app/unified-diff-utils";
import { useDiffWidgets } from "@/components/app/use-diff-widgets";
import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";

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
  focusedFeedbackItemId?: number | null;
  onFeedbackFocusComplete?: (feedbackItemId: number) => void;
};

export const UnifiedDiffView = memo(function UnifiedDiffView({
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
  focusedFeedbackItemId,
  onFeedbackFocusComplete,
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
    try {
      if (language) {
        return tokenizeHunksIndependently(file.hunks, {
          highlight: true,
          refractor: refractorAdapter,
          language,
        });
      }
      return tokenizeHunksIndependently(file.hunks, {});
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

        if (e.shiftKey && lineSelection) {
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

  const widgets = useDiffWidgets({
    file,
    agentId,
    filePath,
    lineSelection,
    onLineSelection,
    commentOpen,
    onCommentOpen,
    reviewMode,
    draftComments,
    onAddDraft,
    onRemoveDraft,
    onUpdateDraft,
    onStartReview,
    feedbackItems,
    focusedFeedbackItemId,
    onFeedbackFocusComplete,
  });

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
            hunks.flatMap((hunk, index) => {
              const key = `${hunk.oldStart}-${hunk.newStart}-${index}`;
              const nodes = [<Hunk key={key} hunk={hunk} />];
              // Skip the leading separator: the file header already marks the
              // start of the diff, so one there would only add noise.
              if (index === 0) return nodes;
              const { range, context } = parseHunkHeader(hunk.content);
              nodes.unshift(
                <Decoration key={`sep-${key}`} className="diff-hunk-separator">
                  <span
                    className="diff-hunk-separator-gutter"
                    aria-hidden="true"
                  >
                    &#8943;
                  </span>
                  <span className="diff-hunk-separator-label">
                    {/* The range marker alone reads as punctuation when
                        announced; say what the row actually means. */}
                    <span className="sr-only">
                      Skipped to line {hunk.newStart}.{" "}
                    </span>
                    <span className="diff-hunk-separator-range">{range}</span>
                    {context ? (
                      <span className="diff-hunk-separator-context">
                        {context}
                      </span>
                    ) : null}
                  </span>
                </Decoration>
              );
              return nodes;
            })
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
