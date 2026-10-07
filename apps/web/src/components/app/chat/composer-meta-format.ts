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
