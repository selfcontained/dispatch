import type { AgentPullRequest } from "@dispatch/shared";

type Check = NonNullable<AgentPullRequest["ci"]>["checks"][number];
const outcome = (c: Check) =>
  c.status === "COMPLETED" && c.conclusion === "SUCCESS"
    ? "passed"
    : c.status === "COMPLETED" &&
        [
          "FAILURE",
          "ERROR",
          "TIMED_OUT",
          "ACTION_REQUIRED",
          "STARTUP_FAILURE",
          "STALE",
        ].includes(c.conclusion ?? "")
      ? "failed"
      : undefined;
const key = (c: Check) => c.identity ?? JSON.stringify([c.name, c.detailsUrl]);
const clean = (s: string, length = 180) =>
  s.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, length);

// Escape labels as literal Markdown, including HTML/autolink delimiters.
const label = (s: string, length = 180) =>
  clean(s, length).replace(/[\\`*_[\]{}()<>!#|~&]/g, "\\$&");
const link = (name: string, url: string | null | undefined, limit = 350) => {
  if (!url || url.length > limit || /[\s\u0000-\u001f]/.test(url)) return name;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return name;
    return `[${name}](<${url.replace(/[<>\\]/g, (c) => encodeURIComponent(c)).replaceAll("&", "&amp;")}>)`;
  } catch {
    return name;
  }
};
export const formatPullRequestLink = (pr: AgentPullRequest) =>
  link(`#${label(pr.url.split("/").at(-1) ?? "PR", 20)}`, pr.url);
export const formatStatusNotice = (
  previous: AgentPullRequest,
  current: AgentPullRequest
) =>
  `${formatPullRequestLink(current)} — ${label(previous.status)} → ${label(current.status)}\nInfo only; no action authorized.`;

/**
 * Initial inventory is a silent baseline. One poll coalesces all newly observed
 * pass/fail results into one bounded notice per owner. Pending/neutral/skipped/
 * cancelled changes alone are silent, but establish a rerun baseline. New heads
 * compare independently; missing/partial data never establishes success.
 */
export function checkChanges(
  previous: AgentPullRequest,
  current: AgentPullRequest
): Check[] {
  const ci = current.ci;
  if (!ci || ci.availability !== "available" || !ci.headSha) return [];
  const before = previous.ci;
  const old = new Map(
    before?.headSha === ci.headSha && before.availability === "available"
      ? before.checks.map((c) => [key(c), c])
      : []
  );
  const unique = new Map<string, Check>();
  for (const c of ci.checks) {
    if (!outcome(c)) continue;
    const prior = old.get(key(c));
    if (
      !prior ||
      outcome(prior) !== outcome(c) ||
      prior.startedAt !== c.startedAt ||
      prior.completedAt !== c.completedAt
    )
      unique.set(key(c), c);
  }
  return [...unique.values()];
}

export function formatCheckNotice(
  previous: AgentPullRequest,
  current: AgentPullRequest
): string | undefined {
  const changed = checkChanges(previous, current);
  if (!changed.length || !current.ci) return undefined;
  const ci = current.ci;
  const passed = ci.checks.filter((c) => outcome(c) === "passed").length;
  const failed = ci.checks.filter((c) => outcome(c) === "failed").length;
  const pending = ci.checks.filter(
    (c) => c.status !== "COMPLETED" || !c.conclusion
  ).length;
  const other = new Map<string, number>();
  for (const c of ci.checks) {
    if (!outcome(c) && c.status === "COMPLETED" && c.conclusion)
      other.set(c.conclusion, (other.get(c.conclusion) ?? 0) + 1);
  }
  const remaining = [...other]
    .slice(0, 10)
    .map(
      ([result, count]) =>
        `${count} ${label(result.toLowerCase().replaceAll("_", " "), 40)}`
    )
    .join(", ");
  // Never label a partial/pending rollup as terminal pass, even if an upstream
  // summary is inconsistent. Cancelled and other conclusions remain explicit.
  const summary = checkSummary(current).toLowerCase();
  const lines = changed.slice(0, 3).map((c) => {
    const ms = Date.parse(c.completedAt ?? "") - Date.parse(c.startedAt ?? "");
    const seconds = Math.round(ms / 1000);
    const duration =
      Number.isFinite(ms) && ms >= 0
        ? ` · ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`}`
        : "";
    return `- ${link(label(c.name, 48) + (c.name.length > 48 ? "…" : ""), c.detailsUrl)} — ${outcome(c)}${duration}`;
  });
  return [
    `${formatPullRequestLink(current)} — ${summary[0].toUpperCase()}${summary.slice(1)} · ${[
      passed && `${passed} passed`,
      failed && `${failed} failed`,
      pending && `${pending} pending`,
      remaining,
    ]
      .filter(Boolean)
      .join(", ")}`,
    ...lines,
    ...(changed.length > 3 ? [`- +${changed.length - 3} more`] : []),
    "",
    `${label(ci.headSha, 12)} · ${Number.isFinite(Date.parse(ci.checkedAt)) ? new Date(ci.checkedAt).toISOString().replace("T", " ").slice(0, 16) + "Z" : "time unknown"} · Info only; no action authorized.`,
  ].join("\n");
}

/** Rollup is independent of risk; cancelled/neutral never imply passing. */
export function checkSummary(
  pr: AgentPullRequest
): "Passing" | "Failing" | "Pending" | "Mixed" {
  const checks = pr.ci?.checks ?? [];
  if (pr.ci?.availability !== "available" || !checks.length) return "Pending";
  return checks.some((c) => outcome(c) === "failed")
    ? "Failing"
    : checks.some((c) => c.status !== "COMPLETED" || !c.conclusion)
      ? "Pending"
      : checks.every((c) => outcome(c) === "passed")
        ? "Passing"
        : "Mixed";
}
