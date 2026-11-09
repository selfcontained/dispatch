/**
 * Opt-in, bounded merge-risk evaluation over backfilled fixtures. Without
 * --live it prints a manifest and makes no requests. Reads the dev token from
 * .env, never touches application databases, caps, or settings, and writes
 * results only under /tmp. Labels (scripts/evals/merge-risk-labels.json) are
 * human judgements per PR number; unlabelled fixtures still report verdict
 * distributions, which is what the first grading pass is for.
 *
 *   bun scripts/evaluate-merge-risk.ts --fixtures /tmp/merge-risk-fixtures.json \
 *     [--live] [--limit 200] [--only labelled] [--out /tmp/merge-risk-evaluation.json] \
 *     [--sheet /tmp/merge-risk-sheet.md]
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
  assessMergeRisk,
  MERGE_RISK_GATE,
  MERGE_RISK_PROMPT_VERSION,
  MERGE_RISK_QUESTIONS,
  type MergeRiskVerdict,
} from "../apps/server/src/agents/merge-risk/policy.js";
import type { MergeRiskEvidence } from "../apps/server/src/agents/merge-risk/evidence.js";

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
const out = path.resolve(option("--out", "/tmp/merge-risk-evaluation.json"));
const sheet = path.resolve(option("--sheet", "/tmp/merge-risk-sheet.md"));
if (
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 1000 ||
  !["all", "labelled"].includes(only) ||
  !out.startsWith("/tmp/") ||
  !sheet.startsWith("/tmp/")
)
  throw new Error(
    "Use --limit 1–1000, --only all|labelled, --out and --sheet under /tmp/."
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
const fixtures = file.fixtures
  .filter((f) => only === "all" || labels[String(f.prNumber)])
  .slice(0, limit);
const fingerprint = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const manifest = {
  model: DECISIONS_MODEL,
  promptVersion: MERGE_RISK_PROMPT_VERSION,
  repo: file.repo,
  fixtures: fixtures.length,
  labelled: fixtures.filter((f) => labels[String(f.prNumber)]).length,
  fixtureHash: fingerprint(fixtures.map((f) => f.evidence)),
  policyHash: fingerprint(MERGE_RISK_QUESTIONS),
  questions: MERGE_RISK_QUESTIONS.map((q) => ({ name: q.name, type: q.type })),
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
        complete: rows.length === fixtures.length,
        summary: summarize(rows),
        results: rows,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  const sorted = [...rows].sort(
    (a, b) => (b.changeRisk ?? -1) - (a.changeRisk ?? -1)
  );
  const pct = (v: number | null) =>
    v === null ? "—" : `${Math.round(v * 100)}%`;
  writeFileSync(
    sheet,
    [
      `# Merge-risk grading sheet (${file.repo}, ${rows.length} PRs, ${MERGE_RISK_PROMPT_VERSION})`,
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
let cursor = 0;
async function worker() {
  while (cursor < fixtures.length) {
    const fixture = fixtures[cursor++]!;
    const response = await requestDecisions(
      key!,
      fixture.evidence as unknown as Record<string, unknown>,
      MERGE_RISK_QUESTIONS,
      { timeoutMs: manifest.timeoutMs }
    );
    const assessment = assessMergeRisk(response.status, response.answers);
    const label = labels[String(fixture.prNumber)] ?? null;
    rows.push({
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
      process.stdout.write(`${rows.length}/${fixtures.length} completed\n`);
    }
  }
}
process.stdout.write(
  `Running ${fixtures.length} merge-risk requests (${manifest.labelled} labelled).\n`
);
await Promise.all([worker(), worker()]);
save();
process.stdout.write(
  JSON.stringify(
    { complete: true, out, sheet, summary: summarize(rows) },
    null,
    2
  ) + "\n"
);
