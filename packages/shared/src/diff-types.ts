/** Added/deleted line counts and a file count for some slice of a diff. */
export type DiffTotals = {
  added: number;
  deleted: number;
  files: number;
};

/**
 * A GitHub-PR-style summary of an agent's diff against its base branch, as
 * computed by `getDiffStats` and pushed over `agent.diff_state_changed`.
 */
export type DiffStats = DiffTotals & {
  /**
   * The same three totals with recognized test files left out, so a client
   * with "Hide test files" on can show a badge that matches the file list the
   * Changes tab renders without fetching the whole diff to add it up itself.
   *
   * Shipping both cuts in one payload works because there is exactly one such
   * filter, and because these stats go out over SSE — one payload for every
   * client, so it cannot be filtered per request. That is the boundary: if a
   * second server-side filter ever appears, the answer is a per-file breakdown
   * behind a separate non-SSE endpoint, not four cuts.
   */
  excludingTests: DiffTotals;
  computedAt: number;
};

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

/**
 * Largest image the Changes pane will render inline, per side. Shared so the
 * client can show the "too large to preview" note without first requesting
 * bytes the image route would refuse to serve anyway.
 */
export const DIFF_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Byte sizes for the two sides of an image file's change, present on
 * `DiffFile.image` only for paths the Changes pane can preview as an image.
 * A side is null when the file does not exist there (added has no old side,
 * deleted has no new side).
 */
export type DiffImageInfo = {
  oldSize: number | null;
  newSize: number | null;
};

/** One file's entry in an agent diff, as returned by `GET /agents/:id/diff`. */
export type DiffFile = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
  added: number;
  deleted: number;
  diff: string | null;
  truncated: boolean;
  /**
   * Whether this file counts as a test. Decided server-side so the client
   * never owns the rule: the Changes tab hides these when "Hide test files" is
   * on, and the same predicate builds `DiffStats.excludingTests`, which is what
   * keeps the rendered list and the +/- badges from disagreeing.
   */
  isTest: boolean;
  /**
   * Set when the path is a previewable raster image, which is what tells the
   * Changes pane to render the picture instead of the "binary file" note.
   * Decided server-side alongside the byte sizes so the client never has to
   * re-derive which extensions the image route will actually serve.
   */
  image?: DiffImageInfo;
};

export type DiffResponse = {
  baseRef: string;
  files: DiffFile[];
  truncatedFileCount?: number;
};

export type FileDiffResponse = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
  added: number;
  deleted: number;
  diff: string;
};
