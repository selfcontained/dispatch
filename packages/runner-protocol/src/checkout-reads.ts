import { isCheckoutView } from "./checkout-view.js";
import { operations } from "./contract/operations.js";
import type { Req } from "./contract/runner.js";
import { isOpaqueId } from "./placement.js";
import { isRecord } from "./validation.js";

const checkoutReadNames = [
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.read",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
  "checkout.image",
  "checkout.defaultFiles",
] as const;

export type CheckoutReadName = (typeof checkoutReadNames)[number];

export type CheckoutReadRequest = {
  [K in CheckoutReadName]: {
    op: K;
    request: Omit<Req<K>, "target">;
    /** Omitted on existing frames: read the currently selected checkout. */
    checkout?: "current" | "launch";
  };
}[CheckoutReadName];

export function isCheckoutReadName(op: unknown): op is CheckoutReadName {
  return checkoutReadNames.some((name) => name === op);
}

export function isCheckoutReadRequest(
  value: unknown,
  session: string
): value is CheckoutReadRequest {
  if (
    !isRecord(value) ||
    !isCheckoutReadName(value.op) ||
    !isRecord(value.request) ||
    (value.checkout !== undefined &&
      value.checkout !== "current" &&
      value.checkout !== "launch") ||
    !operations[value.op].request.check({
      ...value.request,
      target: { session, checkout: value.checkout ?? "current" },
    })
  )
    return false;
  // A Git pathspec must still be a valid checkout-relative file path.
  if (value.op === "checkout.diff" && value.request.path !== undefined)
    return isCheckoutView({
      kind: "fileDiff",
      path: value.request.path,
      baseBranch: value.request.base,
      includeUncommitted: value.request.uncommitted,
      ignoreWhitespace: value.request.whitespace === "ignore",
    });
  if (value.op === "checkout.image")
    return isCheckoutView({
      kind: "image",
      path: value.request.path,
      side: value.request.side,
      baseBranch: value.request.base,
      includeUncommitted: value.request.uncommitted,
    });
  return true;
}

export function isCheckoutReadStream(value: unknown, session: string) {
  return (
    isRecord(value) &&
    isOpaqueId(value.streamId) &&
    isCheckoutReadRequest(value, session)
  );
}
