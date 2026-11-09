/** Opt-in, bounded synthetic evaluation. No database, production messages, or retries. */
import "dotenv/config";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  requestRoutingDecision,
  SHADOW_MODEL,
} from "../apps/server/src/chat/routing-shadow.js";
import {
  durationSummary,
  estimateRoutingUsd,
} from "../apps/server/src/chat/routing-metrics.js";
import {
  STEERING_POLICY,
  selectSteeringChoice,
} from "../apps/server/src/chat/steering-policy.js";
import {
  BASELINE_POLICY,
  CANDIDATE_POLICY,
  COMPACT_POLICY,
  steeringFixtures,
} from "./evals/steering-fixtures.js";
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? "");
};
const split = option("--split", "development");
const policyName = option("--policy", "both");
const limit = Number(option("--limit", "60"));
const repeats = Number(option("--repeats", "2"));
const out = path.resolve(option("--out", "/tmp/steering-evaluation.json"));
if (
  !["development", "holdout", "all"].includes(split) ||
  ![
    "baseline",
    "candidate",
    "current",
    "both",
    "ablations",
    "final-pair",
  ].includes(policyName) ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 120 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 3 ||
  !out.startsWith("/tmp/")
)
  throw new Error(
    "Use split development|holdout|all, policy baseline|candidate|current|both|ablations|final-pair, limit 1–120, repeats 1–3, out /tmp/file.json."
  );
const fixtures = steeringFixtures(
  split as "development" | "holdout" | "all"
).slice(0, limit);
const baseline = {
  name: "baseline",
  policy: BASELINE_POLICY,
  evidenceMode: "full",
};
const final = {
  name: "long-semantic",
  policy: CANDIDATE_POLICY,
  evidenceMode: "semantic",
};
const policies =
  policyName === "ablations"
    ? [
        {
          name: "long-semantic",
          policy: CANDIDATE_POLICY,
          evidenceMode: "semantic",
        },
        { name: "compact-full", policy: COMPACT_POLICY, evidenceMode: "full" },
        {
          name: "compact-semantic",
          policy: COMPACT_POLICY,
          evidenceMode: "semantic",
        },
      ]
    : policyName === "final-pair"
      ? [baseline, final]
      : policyName === "both"
        ? [
            baseline,
            {
              name: "candidate",
              policy: CANDIDATE_POLICY,
              evidenceMode: "full",
            },
          ]
        : [
            {
              name: policyName,
              policy:
                policyName === "baseline"
                  ? BASELINE_POLICY
                  : policyName === "candidate"
                    ? CANDIDATE_POLICY
                    : STEERING_POLICY,
              evidenceMode: policyName === "current" ? "semantic" : "full",
            },
          ];
const jobs = fixtures.flatMap((f) =>
  Array.from({ length: repeats }, (_, repeat) =>
    policies.map((p) => ({ fixture: f, repeat, ...p }))
  ).flat()
);
// Deterministic interleaving reduces ordering confounds and keeps comparisons paired.
let seed = 61109;
for (let i = jobs.length - 1; i > 0; i--) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const j = seed % (i + 1);
  [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!];
}
const fingerprint = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const manifest = {
  model: SHADOW_MODEL,
  split,
  fixtures: fixtures.length,
  baseScenarios: new Set(fixtures.map((f) => f.baseId)).size,
  repeats,
  requests: jobs.length,
  fixtureHash: fingerprint(fixtures),
  policies: policies.map((p) => ({
    variant: p.name,
    hash: fingerprint(p.policy),
    evidenceMode: p.evidenceMode,
    ...p.policy,
  })),
  gate: { probability: 0.8, confidence: 0.8 },
  timeoutMs: 2500,
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
  id: string;
  baseId: string;
  category: string;
  expected: string;
  policy: string;
  repeat: number;
  sameDiscussion: boolean;
  status: string;
  choice: unknown;
  selected: string;
  effective: string;
  rawCorrect: boolean;
  selectedCorrect: boolean;
  effectiveCorrect: boolean;
  applied: boolean;
  incorrectApplied: boolean;
  latencyMs: number;
  confidence: unknown;
  probabilities: unknown;
  usage: unknown;
  estimatedUsd: number | null;
};
const rows: Row[] = [];
function summarize(group: Row[]) {
  const applied = group.filter((r) => r.applied);
  const disagreements = fixtures.flatMap((f) => {
    const r = group.filter((r) => r.id === f.id);
    return new Set(r.map((r) => r.selected)).size > 1 ? [f.id] : [];
  });
  return {
    requests: group.length,
    failures: group.filter((r) => r.status !== "ok").length,
    rawCorrect: group.filter((r) => r.rawCorrect).length,
    selectedCorrect: group.filter((r) => r.selectedCorrect).length,
    effectiveCorrect: group.filter((r) => r.effectiveCorrect).length,
    applied: applied.length,
    incorrectApplied: applied.filter((r) => r.incorrectApplied).length,
    fallbacks: group.filter((r) => r.selected === "keep_existing_default")
      .length,
    repeatDisagreements: disagreements,
    latency: durationSummary(group.map((r) => r.latencyMs)),
    knownEstimatedUsd: group.reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0),
    unpricedCalls: group.filter((r) => r.estimatedUsd === null).length,
    byExpected: Object.fromEntries(
      ["steer_current", "queue_next", "keep_existing_default"].map(
        (expected) => [
          expected,
          {
            requests: group.filter((r) => r.expected === expected).length,
            rawCorrect: group.filter(
              (r) => r.expected === expected && r.rawCorrect
            ).length,
            selectedCorrect: group.filter(
              (r) => r.expected === expected && r.selectedCorrect
            ).length,
            incorrectApplied: group.filter(
              (r) => r.expected === expected && r.incorrectApplied
            ).length,
          },
        ]
      )
    ),
  };
}
function save() {
  writeFileSync(
    out,
    JSON.stringify(
      {
        manifest,
        complete: rows.length === jobs.length,
        summaries: Object.fromEntries(
          policies.map((p) => [
            p.name,
            summarize(rows.filter((r) => r.policy === p.name)),
          ])
        ),
        fixtures,
        results: rows,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
}
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++]!;
    const { fixture, policy } = job;
    const { same_discussion, default_delivery, ...semantic } = fixture.evidence;
    const evidence =
      job.evidenceMode === "semantic" ? semantic : fixture.evidence;
    const response = await requestRoutingDecision(
      key!,
      JSON.stringify(evidence),
      fetch,
      undefined,
      2500,
      policy
    );
    const r: Record<string, unknown> = response.result;
    const selected = selectSteeringChoice(response.status, r);
    const effective =
      selected === "keep_existing_default"
        ? fixture.evidence.default_delivery
        : selected;
    const applied = selected !== "keep_existing_default";
    rows.push({
      id: fixture.id,
      baseId: fixture.baseId,
      category: fixture.category,
      expected: fixture.expected,
      policy: job.name,
      repeat: job.repeat,
      sameDiscussion: fixture.evidence.same_discussion,
      status: response.status,
      choice: r.choice,
      selected,
      effective,
      rawCorrect: response.status === "ok" && r.choice === fixture.expected,
      selectedCorrect: selected === fixture.expected,
      effectiveCorrect:
        fixture.expected === "keep_existing_default"
          ? selected === fixture.expected
          : effective === fixture.expected,
      applied,
      incorrectApplied: applied && selected !== fixture.expected,
      latencyMs: r.latencyMs as number,
      confidence: r.confidence,
      probabilities: r.probabilities,
      usage: r.usage,
      estimatedUsd: estimateRoutingUsd(r.usage),
    });
    if (rows.length % 40 === 0) {
      save();
      process.stdout.write(`${rows.length}/${jobs.length} completed\n`);
    }
  }
}
process.stdout.write(
  `Running ${jobs.length} synthetic requests (${fixtures.length} inputs; ${repeats} repeats; ${policies.length} policies).\n`
);
await Promise.all([worker(), worker()]);
save();
process.stdout.write(
  JSON.stringify(
    {
      complete: true,
      summaries: Object.fromEntries(
        policies.map((p) => [
          p.name,
          summarize(rows.filter((r) => r.policy === p.name)),
        ])
      ),
    },
    null,
    2
  ) + "\n"
);
