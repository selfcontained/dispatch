import type { AgentConfigOption, AgentUsageResponse } from "@dispatch/shared";

import { formatDuration } from "@/lib/format";

/** The settings a person picks here: the model, and how hard it thinks. */
export function pickableOptions(
  options: readonly AgentConfigOption[]
): AgentConfigOption[] {
  const model = options.filter(
    (o) => o.category === "model" || o.id === "model"
  );
  const effort = options.filter(
    (o) =>
      !model.includes(o) &&
      (o.category === "thought_level" ||
        /effort|reasoning|thinking/i.test(o.id))
  );
  return [...model.slice(0, 1), ...effort.slice(0, 1)];
}

export function choiceName(
  option: AgentConfigOption | undefined
): string | null {
  if (!option) return null;
  const choice = option.choices.find((c) => c.value === option.currentValue);
  if (!choice) return option.currentValue || null;
  // A grouped name is named within its group ("GPT" › "6 Sol").
  return choice.group && !choice.name.startsWith(choice.group)
    ? `${choice.group} ${choice.name}`
    : choice.name;
}

/** "42%" of the context window, or null before the engine reported any. */
export function contextPercent(usage: AgentUsageResponse | undefined) {
  const context = usage?.context;
  if (!context) return null;
  return Math.min(100, Math.round((context.used / context.size) * 100));
}

export function formatCost(amount: number, currency: string): string {
  const digits = amount < 1 ? 3 : 2;
  return currency === "USD"
    ? `$${amount.toFixed(digits)}`
    : `${amount.toFixed(digits)} ${currency}`;
}

/** "in 2h 10m", from now; "now" once it has passed. */
export function resetsIn(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return at <= now ? "now" : `in ${formatDuration(at - now)}`;
}

/**
 * How old a plan report is, for its card's corner: "live" for an answer the
 * provider gave in the last minute, "updated 3m ago" for an older one, and
 * "as of 3h ago" for a report the engine left on this machine, which is only
 * as fresh as its last model response here. Null without a timestamp.
 */
export function reportAge(
  observedAt: string | null,
  source: "live" | "local" | undefined,
  now = Date.now()
): string | null {
  if (!observedAt) return null;
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return null;
  const age = Math.max(0, now - at);
  if (source === "local")
    return age < 60_000 ? "as of just now" : `as of ${formatDuration(age)} ago`;
  return age < 60_000 ? "live" : `updated ${formatDuration(age)} ago`;
}

const CREDITS_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

/**
 * "$0.42 of $100.00"; "Off · out of credits" when the provider has extra
 * usage switched off; "—" before it reports any.
 */
export function formatExtraUsage(
  spend:
    | {
        used: number;
        limit: number;
        currency: string;
        enabled?: boolean;
        disabledReason?: string;
      }
    | undefined
): string {
  if (!spend) return "—";
  if (spend.enabled === false) {
    const reason = spend.disabledReason?.replace(/_/g, " ");
    return reason ? `Off · ${reason}` : "Off";
  }
  return `${formatCost(spend.used, spend.currency)} of ${formatCost(spend.limit, spend.currency)}`;
}

/** "3 available", or "—" when the provider does not say. */
export function formatLimitResets(
  resets: { available: number } | undefined
): string {
  return resets ? `${resets.available} available` : "—";
}

const EXPIRY_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/**
 * When the held resets lapse: "Oct 22 · Oct 29 · Nov 6" when each is
 * known (the row's title says what the dates are), "oldest expires in 6d
 * 21h" when only the first is; null when none is held or dated.
 */
export function formatResetExpiry(
  resets:
    | {
        available: number;
        oldestExpiresAt?: string | null;
        items?: Array<{ expiresAt: string | null }>;
      }
    | undefined,
  now = Date.now()
): string | null {
  if (!resets || resets.available === 0) return null;
  const dates = (resets.items ?? [])
    .map((item) => (item.expiresAt ? Date.parse(item.expiresAt) : NaN))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b);
  if (dates.length > 0) {
    return dates.map((at) => EXPIRY_DATE.format(at)).join(" · ");
  }
  const expires = resetsIn(resets.oldestExpiresAt ?? null, now);
  return expires ? `oldest expires ${expires}` : null;
}

/** "12,500", "Unlimited", or "—" when the provider does not say. */
export function formatCredits(
  credits: { balance: number | null; unlimited: boolean } | undefined
): string {
  if (credits?.unlimited) return "Unlimited";
  if (credits?.balance == null) return "—";
  return CREDITS_FORMAT.format(credits.balance);
}
