/**
 * Opt-in, bounded merge-risk evaluation over backfilled fixtures. Without
 * --live it prints a manifest and makes no requests. Reads the dev token from
 * .env, never touches application databases, caps, or settings, and writes
 * results only under /tmp. Labels (scripts/evals/merge-risk-labels.json) are
 * human judgements per PR number; unlabelled fixtures still report verdict
 * distributions, which is what the first grading pass is for.
 *
 *   bun scripts/evaluate-merge-risk.ts --fixtures /tmp/merge-risk-fixtures.json \
 *     [--live] [--limit 200] [--only labelled] [--split all|development|holdout] \
 *     [--policy current|previous|both] [--out /tmp/merge-risk-evaluation.json] \
 *     [--sheet /tmp/merge-risk-sheet.md]
 *
 * The split assigns every third labelled PR (by number) to holdout. Tune on
 * development; confirm once on holdout and do not tune on it afterwards.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DECISIONS_MODEL,
  requestDecisions,
} from "../apps/server/src/chat/decisions-client.js";
import {
  durationSummary,
  estimateRoutingUsd,
} from "../apps/server/src/chat/routing-metrics.js";
import {
  MERGE_RISK_GATE,
  MERGE_RISK_PROMPT_VERSION,
  type MergeRiskVerdict,
} from "../apps/server/src/agents/merge-risk/policy.js";
import type {
  DecisionAnswer,
  DecisionsStatus,
} from "../apps/server/src/chat/decisions-client.js";
import type { MergeRiskEvidence } from "../apps/server/src/agents/merge-risk/evidence.js";
import {
  OFFLINE_GATES,
  POLICIES,
  type PolicyName,
} from "./evals/merge-risk-policies.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? "");
};
const fixturesPath = path.resolve(
  option("--fixtures", "/tmp/merge-risk-fixtures.json")
);
const labelsPath = path.resolve(
  option("--labels", "scripts/evals/merge-risk-labels.json")
);
const limit = Number(option("--limit", "250"));
const only = option("--only", "all");
const split = option("--split", "all");
const policyName = option("--policy", "current");
const out = path.resolve(option("--out", "/tmp/merge-risk-evaluation.json"));
const sheet = path.resolve(option("--sheet", "/tmp/merge-risk-sheet.md"));
if (
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 1000 ||
  !["all", "labelled"].includes(only) ||
  !["all", "development", "holdout"].includes(split) ||
  !["current", "previous", "both"].includes(policyName) ||
  !out.startsWith("/tmp/") ||
  !sheet.startsWith("/tmp/")
)
  throw new Error(
    "Use --limit 1–1000, --only all|labelled, --split all|development|holdout, --policy current|previous|both, --out and --sheet under /tmp/."
  );

type Fixture = {
  id: string;
  prNumber: number;
  url: string;
  state: string;
  mergedAt: string | null;
  evidence: MergeRiskEvidence;
  bytes: number;
  meta: {
    reviews: number;
    findings: number;
    cleanReviews: number;
    subsystems: string[];
    flags: Record<string, number>;
  };
};
type Label = { label: Exclude<MergeRiskVerdict, "abstain">; why?: string };
const file = JSON.parse(readFileSync(fixturesPath, "utf8")) as {
  repo: string;
  fixtures: Fixture[];
};
const labels = (
  JSON.parse(readFileSync(labelsPath, "utf8")) as {
    labels: Record<string, Label>;
  }
).labels;
const labelledNumbers = Object.keys(labels)
  .map(Number)
  .sort((a, b) => a - b);
const holdout = new Set(labelledNumbers.filter((_, i) => i % 3 === 2));
const inSplit = (n: number) =>
  split === "all" ||
  !labels[String(n)] ||
  (split === "holdout") === holdout.has(n);
const fixtures = file.fixtures
  .filter((f) => only === "all" || labels[String(f.prNumber)])
  .filter((f) => inSplit(f.prNumber))
  .slice(0, limit);
const policies = (
  policyName === "both" ? ["current", "previous"] : [policyName]
) as PolicyName[];
const fingerprint = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const manifest = {
  model: DECISIONS_MODEL,
  deployedPromptVersion: MERGE_RISK_PROMPT_VERSION,
  repo: file.repo,
  split,
  fixtures: fixtures.length,
  labelled: fixtures.filter((f) => labels[String(f.prNumber)]).length,
  fixtureHash: fingerprint(fixtures.map((f) => f.evidence)),
  policies: policies.map((name) => ({
    name,
    version: POLICIES[name].version,
    hash: fingerprint(POLICIES[name].questions),
    questions: POLICIES[name].questions.map((q) => `${q.type}:${q.name}`),
  })),
  gate: MERGE_RISK_GATE,
  timeoutMs: 20_000,
  concurrency: 2,
};
if (!args.includes("--live")) {
  process.stdout.write(
    JSON.stringify({ ...manifest, dryRun: true }, null, 2) + "\n"
  );
  process.exit(0);
}
const key = process.env.DISPATCH_DECISIONS_API_KEY?.trim();
if (!key) throw new Error("Set DISPATCH_DECISIONS_API_KEY; no requests made.");

type Row = {
  policy: PolicyName;
  prNumber: number;
  url: string;
  title: string;
  subsystems: string[];
  flags: Record<string, number>;
  reviews: number;
  cleanReviews: number;
  findings: number;
  status: string;
  verdict: MergeRiskVerdict;
  changeRisk: number | null;
  changeRiskLabel: string | null;
  reviewAdequate: number | null;
  descriptionMatches: number | null;
  needsHuman: unknown;
  newSurface: number | null;
  /** Allowlisted provider answers, so gates can be recomputed offline. */
  answers: Record<string, DecisionAnswer>;
  label: Label | null;
  correct: boolean | null;
  falseRoutine: boolean;
  latencyMs: number;
  usage: unknown;
  estimatedUsd: number | null;
};
const rows: Row[] = [];
const count = <T extends string>(values: T[]) =>
  values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
function confusion(group: Row[], verdictOf: (r: Row) => MergeRiskVerdict) {
  const labelled = group.filter((r) => r.label);
  const c = (v: MergeRiskVerdict, l: string) =>
    labelled.filter((r) => verdictOf(r) === v && r.label!.label === l).length;
  return {
    labelled: labelled.length,
    agree: labelled.filter((r) => verdictOf(r) === r.label!.label).length,
    routine_ok: c("routine", "routine"),
    human_ok: c("human_review", "human_review"),
    false_routine: c("routine", "human_review"),
    over_cautious: c("human_review", "routine"),
    abstain_on_routine: c("abstain", "routine"),
    abstain_on_human: c("abstain", "human_review"),
  };
}
function summarize(group: Row[]) {
  const labelled = group.filter((r) => r.label);
  const bySubsystem: Record<string, { n: number; meanRisk: number }> = {};
  for (const r of group)
    for (const s of r.subsystems) {
      const e = (bySubsystem[s] ??= { n: 0, meanRisk: 0 });
      e.meanRisk = (e.meanRisk * e.n + (r.changeRisk ?? 0)) / (e.n + 1);
      e.n++;
    }
  return {
    requests: group.length,
    failures: group.filter((r) => r.status !== "ok").length,
    verdicts: count(group.map((r) => r.verdict)),
    riskLabels: count(group.map((r) => r.changeRiskLabel ?? "none")),
    meanReviewAdequate:
      group.reduce((s, r) => s + (r.reviewAdequate ?? 0), 0) / group.length,
    meanDescriptionMatches:
      group.reduce((s, r) => s + (r.descriptionMatches ?? 0), 0) / group.length,
    labelled: labelled.length,
    correct: labelled.filter((r) => r.correct).length,
    falseRoutine: labelled.filter((r) => r.falseRoutine).length,
    missedHuman: labelled.filter(
      (r) => r.label?.label === "human_review" && r.verdict === "abstain"
    ).length,
    gates: Object.fromEntries(
      Object.entries(OFFLINE_GATES).map(([name, assess]) => [
        name,
        confusion(
          group,
          (r) => assess(r.status as DecisionsStatus, r.answers).verdict
        ),
      ])
    ),
    bySubsystem,
    latency: durationSummary(group.map((r) => r.latencyMs)),
    knownEstimatedUsd: group.reduce((s, r) => s + (r.estimatedUsd ?? 0), 0),
    unpricedCalls: group.filter((r) => r.estimatedUsd === null).length,
  };
}
function save() {
  writeFileSync(
    out,
    JSON.stringify(
      {
        manifest,
        complete: rows.length === fixtures.length * policies.length,
        summaries: Object.fromEntries(
          policies.map((p) => [
            p,
            summarize(rows.filter((r) => r.policy === p)),
          ])
        ),
        results: rows,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  const sorted = [...rows]
    .filter((r) => r.policy === policies[0])
    .sort((a, b) => (b.changeRisk ?? -1) - (a.changeRisk ?? -1));
  const pct = (v: number | null) =>
    v === null ? "—" : `${Math.round(v * 100)}%`;
  writeFileSync(
    sheet,
    [
      `# Merge-risk grading sheet (${file.repo}, ${sorted.length} PRs, ${POLICIES[policies[0]!].version})`,
      "",
      "Fill the **Your call** column with `routine` or `human_review` (what you would have wanted: read it before merge, or not). Add a short why when you disagree with the model.",
      "",
      "| PR | Title | Subsystems / flags | Reviews (clean) · findings | Model verdict | Risk | Review adequate | Desc matches | Your call | Why |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...sorted.map((r) => {
        const flags = Object.entries(r.flags)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}:${n}`)
          .join(" ");
        return `| [#${r.prNumber}](${r.url}) | ${r.title.replace(/\|/g, "\\|").slice(0, 70)} | ${[...r.subsystems, flags].filter(Boolean).join(", ")} | ${r.reviews} (${r.cleanReviews}) · ${r.findings} | **${r.verdict}** | ${r.changeRiskLabel ?? "—"} (${r.changeRisk?.toFixed(2) ?? "—"}) | ${pct(r.reviewAdequate)} | ${pct(r.descriptionMatches)} | ${r.label?.label ?? ""} | ${r.label?.why ?? ""} |`;
      }),
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
}
const jobs = fixtures.flatMap((fixture) =>
  policies.map((policy) => ({ fixture, policy }))
);
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const { fixture, policy } = jobs[cursor++]!;
    const response = await requestDecisions(
      key!,
      fixture.evidence as unknown as Record<string, unknown>,
      POLICIES[policy].questions,
      { timeoutMs: manifest.timeoutMs }
    );
    // Each policy is scored with its own gate: v1 rows describe v1 as deployed.
    const assessment = POLICIES[policy].assess(
      response.status,
      response.answers
    );
    const label = labels[String(fixture.prNumber)] ?? null;
    rows.push({
      policy,
      prNumber: fixture.prNumber,
      url: fixture.url,
      title: fixture.evidence.pull_request.title,
      subsystems: fixture.meta.subsystems,
      flags: fixture.meta.flags,
      reviews: fixture.meta.reviews,
      cleanReviews: fixture.meta.cleanReviews,
      findings: fixture.meta.findings,
      status: response.status,
      ...assessment,
      answers: response.answers,
      label,
      correct: label ? assessment.verdict === label.label : null,
      falseRoutine:
        label?.label === "human_review" && assessment.verdict === "routine",
      latencyMs: response.latencyMs,
      usage: response.usage,
      estimatedUsd: estimateRoutingUsd(response.usage),
    });
    if (rows.length % 20 === 0) {
      save();
      process.stdout.write(`${rows.length}/${jobs.length} completed\n`);
    }
  }
}
process.stdout.write(
  `Running ${jobs.length} merge-risk requests (${fixtures.length} fixtures × ${policies.length} policies; ${manifest.labelled} labelled; split ${split}).\n`
);
await Promise.all([worker(), worker()]);
save();
process.stdout.write(
  JSON.stringify(
    {
      complete: true,
      out,
      sheet,
      summaries: Object.fromEntries(
        policies.map((p) => [p, summarize(rows.filter((r) => r.policy === p))])
      ),
    },
    null,
    2
  ) + "\n"
);
