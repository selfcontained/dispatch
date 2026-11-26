import { isRecord } from "./validation.js";
import { validBranch } from "./checkout.js";

export type WorkspaceView =
  | { kind: "directory" | "preview"; path: string }
  | { kind: "index"; generation: string };

type DiffOptions = { baseBranch: string | null; includeUncommitted: boolean };
export type CheckoutView =
  | WorkspaceView
  | (DiffOptions &
      (
        | { kind: "stats" }
        | { kind: "diff"; ignoreWhitespace: boolean }
        | { kind: "fileDiff"; path: string; ignoreWhitespace: boolean }
        | { kind: "image"; path: string; side: "old" | "new" }
      ));

function relative(path: unknown) {
  return (
    typeof path === "string" &&
    path.length <= 4096 &&
    !path.includes("\0") &&
    path
      .split("/")
      .every(
        (part) =>
          part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"
      )
  );
}

export function isCheckoutView(value: unknown): value is CheckoutView {
  if (!isRecord(value)) return false;
  if (value.kind === "index")
    return (
      typeof value.generation === "string" && value.generation.length <= 64
    );
  if (value.kind === "directory")
    return value.path === "" || relative(value.path);
  if (value.kind === "preview") return relative(value.path);
  if (
    typeof value.includeUncommitted !== "boolean" ||
    !(value.baseBranch === null || validBranch(value.baseBranch))
  )
    return false;
  switch (value.kind) {
    case "stats":
      return true;
    case "diff":
      return typeof value.ignoreWhitespace === "boolean";
    case "fileDiff":
      return (
        relative(value.path) && typeof value.ignoreWhitespace === "boolean"
      );
    case "image":
      return (
        relative(value.path) && (value.side === "old" || value.side === "new")
      );
    default:
      return false;
  }
}

export type CheckoutStatsOutcome = "success" | "partial";

export const MAX_CHECKOUT_VIEW_BYTES = 16 * 1024 * 1024;
