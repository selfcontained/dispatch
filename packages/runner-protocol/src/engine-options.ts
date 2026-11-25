import type { EngineChoice } from "./engine-management.js";

/** Only the option fields consumed by the pure catalog parsers. */
export type EngineConfigOption = {
  id: string;
  category?: string | null;
} & (
  | { type: "boolean" }
  | {
      type: "select";
      currentValue: string;
      options: Array<
        | { value: string; name: string; description?: string | null }
        | {
            group: string;
            name: string;
            options: Array<{
              value: string;
              name: string;
              description?: string | null;
            }>;
          }
      >;
    }
);

export type EngineModelChoice = {
  id: string;
  label: string;
  effort?: EngineChoice[];
};

export type EngineModelReport = {
  /** The model the engine is running now. */
  current: string;
  /** Everything it offers, groups flattened, in the engine's order. */
  choices: EngineModelChoice[];
};

/**
 * An engine's name for a model as a person would say it. codex-acp strips
 * the family off its GPT models ("gpt-5.6-sol" is published as "5.6 Sol")
 * because its own picker shows them under a "GPT" heading; the flat list
 * here has no heading, so the family goes back on.
 */
function modelLabel(value: string, name: string): string {
  // Only a bare version ("5.6 Sol") is a stripped name; anything else is
  // the engine's own wording and stays as it is.
  if (/^gpt-/i.test(value) && /^\d/.test(name)) return `GPT-${name}`;
  return name;
}

/**
 * The model option among an engine's session config options, or null when
 * it publishes none. Engines name it `model` or file it under the `model`
 * category; either counts, and the first match wins.
 */
export function modelOptionOf(
  options: readonly EngineConfigOption[]
): EngineModelReport | null {
  const option = options.find(
    (o) => o.type === "select" && (o.id === "model" || o.category === "model")
  );
  if (!option || option.type !== "select") return null;
  const choices: EngineModelChoice[] = [];
  const add = (o: { value: string; name: string }, group?: string) => {
    // The picker has its own "Default" (no override); the engine's entry
    // for the same thing would be a second one.
    if (o.value === "default") return;
    // A grouped choice is named within its group ("GPT" › "6 Astra"); the
    // flat list needs the whole name.
    const name = modelLabel(o.value, o.name);
    const label =
      group && !name.toLowerCase().startsWith(group.toLowerCase())
        ? `${group} ${name}`
        : name;
    choices.push({ id: o.value, label });
  };
  for (const entry of option.options) {
    if ("group" in entry) entry.options.forEach((o) => add(o, entry.name));
    else add(entry);
  }
  const current = String(option.currentValue);
  return { current, choices };
}

export function engineEffortOption(options: readonly EngineConfigOption[]) {
  const effortOption = options.find(
    (o) =>
      o.type === "select" &&
      (o.category === "thought_level" ||
        /effort|reasoning|thinking/i.test(o.id))
  );
  return effortOption?.type === "select"
    ? effortOption.options
        .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
        .filter((choice) => choice.value !== "default")
        .map((choice) => ({
          value: choice.value,
          name: choice.name,
          ...(choice.description ? { description: choice.description } : {}),
        }))
    : [];
}

export function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const pa = a.split(/\D+/).filter(Boolean).map(Number);
  const pb = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
