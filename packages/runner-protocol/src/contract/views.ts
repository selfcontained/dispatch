/* Checkout view and inspection results, typed from the view and inspection workers' output. */
import { runnerPath } from "./opaque.js";
import {
  array,
  boolean,
  integer,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
} from "./schema.js";

export const directoryListing = object({
  names: optional(array(string)),
  truncated: boolean,
  entries: array(
    object({
      name: string,
      path: string,
      kind: literal("file", "directory", "link", "other"),
    })
  ),
});

export const preview = union(
  object({ kind: literal("text"), size: integer, text: string }),
  object({ kind: literal("image"), size: integer, src: string }),
  object({ kind: literal("svg"), size: integer, text: string, src: string }),
  object({ kind: literal("unsupported"), size: integer, message: string })
);

export const fileIndex = object({
  source: literal("git", "folders"),
  paths: array(string),
  truncated: boolean,
});

const totals = { files: integer, added: integer, deleted: integer };

export const stats = nullable(
  object({
    ...totals,
    /** Totals with the request's `exclude` patterns left out. */
    excluded: object(totals),
    computedAt: integer,
    outcome: optional(literal("success", "partial")),
  })
);

const fileDiffFields = {
  path: string,
  oldPath: optional(string),
  status: literal("modified", "added", "deleted", "renamed"),
  added: integer,
  deleted: integer,
  diff: nullable(string),
};

export const fileDiff = object({ ...fileDiffFields, diff: string });

export const diff = object({
  baseRef: nullable(string),
  files: array(
    object({
      ...fileDiffFields,
      /** Matched the request's `exclude` patterns. */
      excluded: boolean,
      truncated: boolean,
      image: optional(
        object({
          revision: optional(string),
          oldSize: nullable(integer),
          newSize: nullable(integer),
        })
      ),
    })
  ),
  truncatedFileCount: optional(integer),
});

export const changes = object({
  baseRef: string,
  head: string,
  stateId: string,
  files: array(string),
});

export const defaultFiles = object({
  hasOrigin: boolean,
  files: array(object({ path: string, content: string })),
  warnings: array(string),
  refreshing: boolean,
  updatedAt: nullable(number),
  truncated: boolean,
});

export const checkoutState = object({
  path: runnerPath,
  branch: nullable(string),
  stateId: string,
  unmerged: boolean,
  changedFiles: array(string),
  uncommittedFiles: array(string),
});

export const observation = object({
  ownership: literal("owned", "borrowed", "external", "none"),
  owner: nullable(string),
  borrowers: array(string),
  checkout: nullable(checkoutState),
});
