import type { CheckoutCommand } from "@dispatch/runner-protocol";
const REPO_TOOL_TIMEOUT_MS = 5 * 60_000;
const LIFECYCLE_HOOK_TIMEOUT_MS = 15_000;
export function checkoutCommandTimeoutMs(
  checkout: CheckoutCommand["checkout"]
): number {
  // Repo tools can start or rebuild project services before returning.
  return checkout === "effective"
    ? REPO_TOOL_TIMEOUT_MS
    : LIFECYCLE_HOOK_TIMEOUT_MS;
}
