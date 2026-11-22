// Turns what a scenario observed into comparable values, and compares them.
// The only things removed before comparing are the entries in substitutions.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const substitutions = JSON.parse(
  readFileSync(new URL("./substitutions.json", import.meta.url), "utf8")
);
const ABSENT = Symbol("absent");
const SHORT = 160;
const collator = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `bindings` are the values the harness itself generated for one side. */
export function createNormaliser(bindings = {}, rules = substitutions) {
  const compiled = rules.map((rule) => {
    const bound = rule.bound ? bindings[rule.bound] : undefined;
    const numbers = new Map();
    if (rule.bound === "agents")
      // Only the harness's own agents keep one number across steps. An agent
      // Dispatch launched must not renumber the steps after it.
      for (const id of bound ?? []) numbers.set(id, String(numbers.size + 1));
    return {
      rule,
      bound,
      numbers,
      launched: new Map(),
      pattern: rule.pattern && new RegExp(rule.pattern, "g"),
    };
  });

  function text(input) {
    let value = input;
    for (const { rule, bound, numbers, launched, pattern } of compiled) {
      if (rule.bound === "agents") {
        // Default branch and reviewer names carry the id's last six characters.
        for (const id of new Set([
          ...numbers.keys(),
          ...(bindings.launched ?? []),
        ]))
          value = value.replace(
            new RegExp(`-${id.slice(-6)}(?![0-9a-f])`, "g"),
            `-<agent:${numbers.get(id) ?? "launched"}>`
          );
      } else if (rule.bound === "port") {
        if (bound)
          value = value.replace(
            new RegExp(`(127\\.0\\.0\\.1|localhost):${bound}(?!\\d)`, "g"),
            `$1:${rule.replace}`
          );
      } else if (rule.bound) {
        for (const item of [bound ?? []].flat())
          if (item)
            value = value.replace(
              new RegExp(escape(String(item)), "g"),
              rule.replace
            );
      }
      if (!pattern) continue;
      value = value.replace(pattern, (match) => {
        if (!rule.numbered && rule.bound !== "agents") return rule.replace;
        const label = rule.replace.slice(0, -1);
        if (rule.bound === "agents") {
          const id = match.replace("agt-", "agt_");
          if (numbers.has(id)) return `${label}:${numbers.get(id)}>`;
          if (!launched.has(id)) launched.set(id, launched.size + 1);
          return `${label}:launched-${launched.get(id)}>`;
        }
        if (!numbers.has(match)) numbers.set(match, numbers.size + 1);
        return `${label}:${numbers.get(match)}>`;
      });
    }
    return value;
  }

  function normalise(value, key) {
    const rule = key && compiled.find((item) => item.rule.keys?.includes(key));
    if (rule && value !== null) {
      const { bound, type, valuePattern, replace } = rule.rule;
      const matches = bound
        ? String(value) === String(rule.bound)
        : typeof value === type &&
          (!valuePattern || new RegExp(valuePattern).test(String(value)));
      if (matches) return replace;
    }
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => normalise(item));
    if (isObject(value))
      // Fixed visiting order, so numbering does not depend on key order.
      return Object.fromEntries(
        Object.keys(value)
          .sort(collator)
          .filter((name) => value[name] !== undefined)
          .map((name) => [text(name), normalise(value[name], name)])
      );
    return value;
  }
  return normalise;
}

/** A value as the ledgers store it: exact when short, pinned by hash when long. */
export function represent(value) {
  if (value === ABSENT) return "<absent>";
  const json = JSON.stringify(value) ?? "<absent>";
  if (json.length <= SHORT) return json;
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  return `sha256:${hash} ${json.slice(0, 100)}…`;
}

/** The smallest set of paths at which two normalised values differ. */
export function differences(main, head, path = []) {
  if (isDeepStrictEqual(main, head)) return [];
  if (isObject(main) && isObject(head))
    return [...new Set([...Object.keys(main), ...Object.keys(head)])]
      .sort(collator)
      .flatMap((key) =>
        differences(
          Object.hasOwn(main, key) ? main[key] : ABSENT,
          Object.hasOwn(head, key) ? head[key] : ABSENT,
          [...path, key]
        )
      );
  if (Array.isArray(main) && Array.isArray(head) && main.length === head.length)
    return main.flatMap((item, index) =>
      differences(item, head[index], [...path, String(index)])
    );
  return [
    {
      path: path.join(" > "),
      main: represent(main),
      head: represent(head),
    },
  ];
}

/**
 * A whole scenario. Uuids are numbered within each recorded step, so fixing
 * one step cannot renumber, and so change, another step's ledger entries.
 */
export function normaliseObserved(observed, bindings) {
  return Object.fromEntries(
    Object.entries(observed).map(([step, value]) => {
      const normalise = createNormaliser(bindings);
      return [normalise(step), normalise(value)];
    })
  );
}
