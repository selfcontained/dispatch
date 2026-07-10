import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { MessageSquare } from "lucide-react";

import { type DiffViewType } from "@/lib/store";
import { cn } from "@/lib/utils";
import { type DraftComment } from "@/components/app/review-mode";
import {
  InlineCommentForm,
  InlineDraftAnnotation,
  InlineFeedbackAnnotation,
} from "@/components/app/diff-annotations";
import { type ReviewFeedbackItem } from "@/hooks/use-agent-reviews";

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

export type LineSelection = {
  filePath: string;
  startLine: number;
  endLine: number;
  anchorLine: number;
};

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

export function findLastChangeKeyInRange(
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

    if (feedbackItems) {
      const grouped = new Map<string, typeof feedbackItems>();
      for (const fi of feedbackItems) {
        if (fi.lineStart == null) continue;
        const key = findLastChangeKeyInRange(
          file.hunks,
          fi.lineStart,
          fi.lineEnd ?? fi.lineStart
        );
        if (!key) continue;
        const list = grouped.get(key) ?? [];
        list.push(fi);
        grouped.set(key, list);
      }
      for (const [key, items] of grouped) {
        w[key] = (
          <>
            {items.map((fi) => {
              const firstMsg = fi.messages[0]?.content?.body ?? "";
              const isResolved = fi.status === "resolved";
              return (
                <InlineFeedbackAnnotation
                  key={fi.id}
                  feedbackItem={fi}
                  comment={firstMsg}
                  isResolved={isResolved}
                />
              );
            })}
          </>
        );
      }
    }

    if (draftComments) {
      for (const draft of draftComments) {
        const key = findLastChangeKeyInRange(
          file.hunks,
          draft.startLine,
          draft.endLine
        );
        if (!key) continue;
        const draftWidget = (
          <InlineDraftAnnotation
            draft={draft}
            onRemove={onRemoveDraft}
            onUpdate={onUpdateDraft}
          />
        );
        const existing = w[key];
        w[key] = existing ? (
          <>
            {existing}
            {draftWidget}
          </>
        ) : (
          draftWidget
        );
      }
    }

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
