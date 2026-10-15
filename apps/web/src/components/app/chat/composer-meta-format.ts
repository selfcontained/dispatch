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

/** "12,500", "Unlimited", or "—" when the provider does not say. */
export function formatCredits(
  credits: { balance: number | null; unlimited: boolean } | undefined
): string {
  if (credits?.unlimited) return "Unlimited";
  if (credits?.balance == null) return "—";
  return CREDITS_FORMAT.format(credits.balance);
}
