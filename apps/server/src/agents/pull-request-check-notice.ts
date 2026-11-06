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
const key = (c: Check) => JSON.stringify([c.name, c.detailsUrl]);
const clean = (s: string, length = 180) =>
  s.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, length);

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
    .map(([result, count]) => `${count} ${clean(result, 40)}`)
    .join(", ");
  // Never label a partial/pending rollup as terminal pass, even if an upstream
  // summary is inconsistent. Cancelled and other conclusions remain explicit.
  const summary = ci.checks.some((c) => outcome(c) === "failed")
    ? "failing"
    : ci.checks.some((c) => c.status !== "COMPLETED" || !c.conclusion)
      ? "pending"
      : ci.checks.every((c) => outcome(c) === "passed")
        ? "passing"
        : "mixed (includes neutral/skipped/cancelled or other results)";
  const lines = changed.slice(0, 8).map((c) => {
    const ms = Date.parse(c.completedAt ?? "") - Date.parse(c.startedAt ?? "");
    const duration =
      Number.isFinite(ms) && ms >= 0 ? `; ${Math.round(ms / 1000)}s` : "";
    const link =
      c.detailsUrl && /^https?:\/\//.test(c.detailsUrl)
        ? `; ${clean(c.detailsUrl, 350)}`
        : "";
    return `- ${clean(c.name)}: ${outcome(c)} (${clean(c.conclusion ?? "")})${duration}${link}`;
  });
  return [
    `Dispatch system: tracked PR checks changed. #${current.url.split("/").at(-1)} ${clean(current.title)}: ${current.url}`,
    `Observed head ${clean(ci.headSha, 12)} at ${clean(ci.checkedAt)}. Outcome: ${summary}; ${passed} passed, ${failed} failed, ${pending} pending${remaining ? `, ${remaining}` : ""}.`,
    ...lines,
    ...(changed.length > 8
      ? [`… ${changed.length - 8} more changed results; see PR.`]
      : []),
    "Observation only; no action is authorized by this notice.",
  ].join("\n");
}
