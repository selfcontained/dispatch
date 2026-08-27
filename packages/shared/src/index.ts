/**
 * Contracts both the API server and the web client have to agree on.
 *
 * Anything here is imported by `apps/server` and `apps/web` alike, so it must
 * stay dependency-free and runtime-free: no `node:` imports, no browser APIs.
 * Types only for now — a value would land in the browser bundle and in the
 * compiled server binary at once.
 */
export type {
  DiffFile,
  DiffFileStatus,
  DiffResponse,
  DiffStats,
  DiffTotals,
  FileDiffResponse,
} from "./diff-types.js";
