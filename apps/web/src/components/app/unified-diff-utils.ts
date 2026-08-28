import {
  markEdits,
  tokenize,
  getChangeKey,
  type ChangeData,
  type HunkTokens,
  type HunkData,
  type TokenizeOptions,
} from "react-diff-view";

export type LineSelection = {
  filePath: string;
  startLine: number;
  endLine: number;
  anchorLine: number;
};

/**
 * Highlight each displayed hunk in isolation. A diff only includes a small
 * amount of surrounding source, so a multi-line construct can begin in one
 * hunk while its terminator is omitted before the next. Highlighting the
 * assembled file would then incorrectly carry that lexical state forward.
 */
export function tokenizeHunksIndependently(
  hunks: HunkData[],
  options: TokenizeOptions
): HunkTokens {
  const merged: HunkTokens = { old: [], new: [] };

  for (const hunk of hunks) {
    const oldOffset = hunk.oldStart - 1;
    const newOffset = hunk.newStart - 1;
    const localHunk: HunkData = {
      ...hunk,
      oldStart: 1,
      newStart: 1,
      changes: hunk.changes.map((change) => {
        if (change.type === "delete") {
          return { ...change, lineNumber: change.lineNumber - oldOffset };
        }
        if (change.type === "insert") {
          return { ...change, lineNumber: change.lineNumber - newOffset };
        }
        return {
          ...change,
          oldLineNumber: change.oldLineNumber - oldOffset,
          newLineNumber: change.newLineNumber - newOffset,
        };
      }),
    };
    const hunkTokens = tokenize([localHunk], {
      ...options,
      enhancers: [markEdits([localHunk])],
    });

    for (const side of ["old", "new"] as const) {
      const offset = side === "old" ? oldOffset : newOffset;
      for (const change of hunk.changes) {
        const lineNumber =
          side === "old"
            ? change.type === "insert"
              ? null
              : change.type === "delete"
                ? change.lineNumber
                : change.oldLineNumber
            : change.type === "delete"
              ? null
              : change.type === "insert"
                ? change.lineNumber
                : change.newLineNumber;
        if (lineNumber === null) continue;

        const localLineNumber = lineNumber - offset;
        merged[side][lineNumber - 1] =
          hunkTokens[side][localLineNumber - 1] ?? [];
      }
    }
  }

  return merged;
}

export function getNewLineNumber(change: ChangeData): number | null {
  if (change.type === "insert") return change.lineNumber;
  if (change.type === "normal") return change.newLineNumber;
  return null;
}

export function collectSelectedChangeKeys(
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

export type HunkSeparatorLabel = {
  /** The `@@ -a,b +c,d @@` range marker. */
  range: string;
  /** Trailing context git emits after the range (usually the enclosing symbol). */
  context: string;
};

/**
 * Split a hunk's header line into its range marker and trailing context so the
 * separator row can render them with different emphasis.
 */
export function parseHunkHeader(content: string): HunkSeparatorLabel {
  const match = /^(@@[^@]*@@)\s?(.*)$/.exec(content);
  if (!match) return { range: content.trim(), context: "" };
  return { range: match[1]!, context: match[2]!.trim() };
}
