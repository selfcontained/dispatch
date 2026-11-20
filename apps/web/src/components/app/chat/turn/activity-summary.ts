import { useRef } from "react";

import type { Step } from "./contracts";
import { activitySteps } from "./activity-steps";
import { activityCategory, type ActivityCategory } from "./activity-category";

/**
 * The newest complete sentence the agent has written this turn, for the
 * one-line preview. Walks back from the newest paragraph and takes its last
 * finished sentence; in a paragraph still streaming, text after the last
 * sentence end is unfinished and skipped, so a half-written sentence is
 * never shown. Each sentence the agent finishes replaces the last.
 */
export function progressSummary(
  text: string,
  streaming: boolean
): string | undefined {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const flat = paragraphs[i]!.replace(/\s+/g, " ").trim();
    const open = streaming && i === paragraphs.length - 1;
    const done = flat.match(/.+?[.!?](?=\s|$)/g) ?? [];
    const rest = flat.slice(done.join("").length).trim();
    // A finished paragraph's closing words count without a period.
    const sentence = !open && rest ? rest : done[done.length - 1]?.trim();
    if (sentence) return sentence.replace(/[.:]$/, "");
  }
  return undefined;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const PARTS: [ActivityCategory, (n: number) => string][] = [
  ["read", (n) => plural(n, "read", "reads")],
  ["edit", (n) => plural(n, "edit", "edits")],
  ["checks", (n) => plural(n, "check", "checks")],
  ["git", (n) => plural(n, "git call", "git calls")],
  ["browser", (n) => plural(n, "browser step", "browser steps")],
  ["dispatch", (n) => plural(n, "agent call", "agent calls")],
  ["dev", (n) => plural(n, "dev tool", "dev tools")],
  ["other", (n) => plural(n, "command", "commands")],
];

function format(counts: Map<ActivityCategory, number>, failed: number) {
  const parts: string[] = [];
  for (const [cat, fmt] of PARTS) {
    const n = counts.get(cat) ?? 0;
    if (n) parts.push(fmt(n));
  }
  if (failed) parts.push(`${failed} failed`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** A step that has not said what it is yet: a call still arriving has no input. */
function unresolved(step: Step): boolean {
  if (step.status !== "pending") return false;
  const input = (step.detail as { input?: unknown } | undefined)?.input;
  return !input || typeof input !== "object";
}

/**
 * The whole turn so far by kind of work: "6 reads · 2 edits · 3 checks ·
 * 1 failed". Each step is counted once, under the kind it had when it first
 * said what it was, and stays there, so the numbers only ever go up: a
 * call's kind can change as its input streams in, and a step the feed
 * drops from view is still counted.
 */
export function useActivitySum(steps: Step[]): string | undefined {
  // Held for the life of the component, which is one turn's placeholder.
  const seen = useRef<{
    kinds: Map<string, ActivityCategory>;
    failed: Set<string>;
  } | null>(null);
  seen.current ??= { kinds: new Map(), failed: new Set() };
  const memo = seen.current;
  for (const step of activitySteps(steps)) {
    if (step.kind === "think" || step.kind === "note" || step.kind === "notice")
      continue;
    if (!memo.kinds.has(step.id) && !unresolved(step))
      memo.kinds.set(step.id, activityCategory(step));
    if (step.status === "error") memo.failed.add(step.id);
  }
  const counts = new Map<ActivityCategory, number>();
  for (const cat of memo.kinds.values())
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  return format(counts, memo.failed.size);
}
