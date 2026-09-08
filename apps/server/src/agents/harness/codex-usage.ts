import type { HarnessSubscriptionUsage } from "@dispatch/shared";

import type { CodexGrant } from "./credentials.js";
import {
  BillingStatusError,
  PROVIDER_DEADLINE_MS,
  readJson,
  type FetchLike,
} from "./usage-http.js";

/**
 * The ChatGPT plan behind the openai-codex route is billed by rate-limit
 * windows, not dollars. This is the usage client for it: the same call
 * Codex's own client makes for its usage view, with the headers pi-ai
 * sends on the route's model calls.
 */

/** Where the ChatGPT backend reports a plan's rate-limit windows. */
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type CodexWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};
type CodexUsageBody = {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
  } | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
  } | null;
};

function windowLabel(
  id: "primary" | "secondary",
  seconds: number | null
): string {
  if (seconds !== null && seconds > 0) {
    if (seconds % 86_400 === 0) {
      const days = seconds / 86_400;
      return days === 7 ? "Weekly" : `${days}-day`;
    }
    if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`;
  }
  return id === "primary" ? "Short window" : "Long window";
}

function shapeWindow(
  id: "primary" | "secondary",
  raw: CodexWindow | null | undefined,
  now: Date
): HarnessSubscriptionUsage["windows"][number] | null {
  if (!raw || typeof raw.used_percent !== "number") return null;
  const seconds =
    typeof raw.limit_window_seconds === "number"
      ? raw.limit_window_seconds
      : null;
  let resetsAt: string | null = null;
  if (typeof raw.reset_at === "number") {
    resetsAt = new Date(raw.reset_at * 1000).toISOString();
  } else if (typeof raw.reset_after_seconds === "number") {
    resetsAt = new Date(
      now.getTime() + raw.reset_after_seconds * 1000
    ).toISOString();
  }
  return {
    id,
    label: windowLabel(id, seconds),
    usedPercent: Math.max(0, Math.min(100, Math.round(raw.used_percent))),
    windowSeconds: seconds,
    resetsAt,
  };
}

/**
 * The plan's rate-limit windows for the signed-in account. The access
 * token in the store is used as is; dsh refreshes it under the store's
 * lock on its own calls, so an expired one here means the harness has not
 * run on the route for a while.
 */
export async function fetchCodexUsage(
  grant: CodexGrant,
  fetchFn: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(PROVIDER_DEADLINE_MS),
  now = new Date()
): Promise<HarnessSubscriptionUsage> {
  if (typeof grant.expires === "number" && grant.expires <= now.getTime()) {
    throw new BillingStatusError(
      "The ChatGPT sign-in has expired; the next harness turn on the ChatGPT route renews it."
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${grant.access}`,
    originator: "pi",
    Accept: "application/json",
  };
  if (grant.accountId) headers["chatgpt-account-id"] = grant.accountId;
  const res = await fetchFn(CODEX_USAGE_URL, { headers, signal });
  if (res.status === 401) {
    throw new BillingStatusError(
      "ChatGPT answered 401: the stored sign-in was refused; sign in again from the harness home."
    );
  }
  if (res.status === 403) {
    throw new BillingStatusError(
      "ChatGPT answered 403: this account or plan is not allowed to use the Codex route."
    );
  }
  if (!res.ok) throw new BillingStatusError(`ChatGPT answered ${res.status}.`);
  const body = await readJson<CodexUsageBody>(res, "ChatGPT");
  const windows: HarnessSubscriptionUsage["windows"] = [];
  const primary = shapeWindow("primary", body.rate_limit?.primary_window, now);
  const secondary = shapeWindow(
    "secondary",
    body.rate_limit?.secondary_window,
    now
  );
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  const credits = body.credits;
  const balance =
    typeof credits?.balance === "number"
      ? credits.balance
      : typeof credits?.balance === "string" && credits.balance.trim() !== ""
        ? Number(credits.balance)
        : null;
  return {
    plan: typeof body.plan_type === "string" ? body.plan_type : null,
    windows,
    credits:
      credits && (credits.has_credits || credits.unlimited)
        ? {
            balance:
              balance !== null && Number.isFinite(balance) ? balance : null,
            unlimited: credits.unlimited === true,
          }
        : null,
    limitReached: body.rate_limit?.limit_reached === true,
  };
}
