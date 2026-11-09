/**
 * One-time, read-only backfill: rebuild the merge-risk evidence payload for
 * every pull request a Dispatch instance has already shipped, so the policy
 * can be tuned against real history before it runs live.
 *
 * Reads a Dispatch database in a read-only session (PR attachments, review
 * blocks, findings, launch briefings) and GitHub via `gh` (PR metadata, files,
 * current head check rollup). Makes no Decisions API calls, writes nothing to
 * the database, and writes fixtures only under /tmp with mode 0600. Fixtures
 * contain PR descriptions and review text; do not commit them.
 *
 *   bun scripts/backfill-merge-risk.ts --database-url postgres://… \
 *     --repo owner/name [--since 2026-10-10] [--limit 200] \
 *     [--out /tmp/merge-risk-fixtures.json]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  buildMergeRiskEvidence,
  type MergeRiskInput,
} from "../apps/server/src/agents/merge-risk/evidence.js";
import {
  loadBriefing,
  loadReviewEvidence,
  readPullRequestDetails,
} from "../apps/server/src/agents/merge-risk/sources.js";
import { mapPullRequestChecks } from "../apps/server/src/agents/pull-request-reader.js";
import {
  loadCodeowners,
  type CodeownersConfig,
} from "../apps/server/src/personas/codeowners.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? "");
};
const databaseUrl =
  option("--database-url", "") ||
  process.env.MERGE_RISK_BACKFILL_DATABASE_URL?.trim() ||
  "";
const repo = option("--repo", "");
const since = option("--since", "2026-01-01");
const limit = Number(option("--limit", "250"));
const out = path.resolve(option("--out", "/tmp/merge-risk-fixtures.json"));
const ownersRoot = path.resolve(option("--owners-root", process.cwd()));
if (
  !databaseUrl ||
  !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !/^\d{4}-\d{2}-\d{2}$/.test(since) ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 1000 ||
  !out.startsWith("/tmp/")
)
  throw new Error(
    "Use --database-url (or MERGE_RISK_BACKFILL_DATABASE_URL), --repo owner/name, --since YYYY-MM-DD, --limit 1–1000, --out /tmp/file.json."
  );

type PrRow = {
  url: string;
  number: number;
  streams: string[];
  firstSeen: string;
};

// Every session is read-only at the server level; a stray write fails loudly.
const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  options: "-c default_transaction_read_only=on",
});

async function listPullRequests(): Promise<PrRow[]> {
  const prefix = `https://github.com/${repo.toLowerCase()}/pull/`;
  const rows = await pool.query<{
    url: string;
    stream_id: string;
    first_seen: string;
  }>(
    `SELECT lower(a->>'url') AS url, b.stream_id, min(b.created_at) AS first_seen
       FROM blocks b, jsonb_array_elements(b.attachments) a
      WHERE a->>'type' = 'pr' AND lower(a->>'url') LIKE $1 AND b.created_at >= $2::date
      GROUP BY 1, 2 ORDER BY 3`,
    [`${prefix}%`, since]
  );
  const byUrl = new Map<string, PrRow>();
  for (const row of rows.rows) {
    const number = Number(row.url.slice(prefix.length).replace(/\/$/, ""));
    if (!Number.isInteger(number)) continue;
    const url = `${prefix}${number}`;
    const entry = byUrl.get(url) ?? {
      url,
      number,
      streams: [],
      firstSeen: row.first_seen,
    };
    if (!entry.streams.includes(row.stream_id))
      entry.streams.push(row.stream_id);
    byUrl.set(url, entry);
  }
  return [...byUrl.values()]
    .sort((a, b) => a.number - b.number)
    .slice(0, limit);
}

let owners: CodeownersConfig | null = null;
try {
  owners = await loadCodeowners(ownersRoot);
} catch (error) {
  process.stderr.write(
    `No ownership map at ${ownersRoot}; subsystems will be empty (${error instanceof Error ? error.message : String(error)}).\n`
  );
}

const prs = await listPullRequests();
process.stdout.write(
  `Found ${prs.length} pull requests for ${repo} since ${since}.\n`
);
type Fixture = {
  id: string;
  prNumber: number;
  url: string;
  state: string;
  mergedAt: string | null;
  streams: string[];
  evidence: ReturnType<typeof buildMergeRiskEvidence>;
  bytes: number;
  meta: {
    reviews: number;
    findings: number;
    cleanReviews: number;
    subsystems: string[];
    flags: Record<string, number>;
  };
};
const fixtures: Fixture[] = [];
const skipped: { number: number; reason: string }[] = [];
let cursor = 0;
async function worker() {
  while (cursor < prs.length) {
    const pr = prs[cursor++]!;
    const gh = await readPullRequestDetails(pr.url);
    if (!gh) {
      skipped.push({ number: pr.number, reason: "gh pr view failed" });
      continue;
    }
    const [reviews, briefing] = await Promise.all([
      loadReviewEvidence(pool, pr.streams),
      loadBriefing(pool, pr.streams),
    ]);
    const ci = mapPullRequestChecks(gh.headRefOid, gh.statusCheckRollup);
    const input: MergeRiskInput = {
      pullRequest: {
        number: gh.number,
        title: gh.title,
        body: gh.body ?? "",
        baseRef: gh.baseRefName,
        headRef: gh.headRefName,
        additions: gh.additions,
        deletions: gh.deletions,
      },
      files: gh.files,
      owners,
      briefing,
      reviews,
      ci:
        ci.availability === "available"
          ? {
              status: ci.summary.status,
              total: ci.summary.total,
              passed: ci.summary.passed,
              failed: ci.summary.failed,
              pending: ci.summary.pending,
            }
          : null,
    };
    const evidence = buildMergeRiskEvidence(input);
    fixtures.push({
      id: `pr-${gh.number}`,
      prNumber: gh.number,
      url: pr.url,
      state: gh.state,
      mergedAt: gh.mergedAt,
      streams: pr.streams,
      evidence,
      bytes: Buffer.byteLength(JSON.stringify(evidence), "utf8"),
      meta: {
        reviews: reviews.length,
        findings: reviews.reduce((n, r) => n + r.findings.length, 0),
        cleanReviews: reviews.filter((r) => r.findings.length === 0).length,
        subsystems: Object.keys(evidence.change_summary.subsystems),
        flags: evidence.change_summary.flags,
      },
    });
    if ((fixtures.length + skipped.length) % 20 === 0)
      process.stdout.write(
        `${fixtures.length + skipped.length}/${prs.length} processed\n`
      );
  }
}
await Promise.all([worker(), worker(), worker()]);
await pool.end();
fixtures.sort((a, b) => a.prNumber - b.prNumber);
writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      repo,
      since,
      ownersRoot: owners ? ownersRoot : null,
      count: fixtures.length,
      skipped,
      fixtures,
    },
    null,
    2
  ) + "\n",
  { mode: 0o600 }
);
const states = fixtures.reduce<Record<string, number>>((acc, f) => {
  acc[f.state] = (acc[f.state] ?? 0) + 1;
  return acc;
}, {});
process.stdout.write(
  JSON.stringify(
    {
      out,
      fixtures: fixtures.length,
      skipped: skipped.length,
      states,
      bytes: {
        max: Math.max(...fixtures.map((f) => f.bytes)),
        median: fixtures.map((f) => f.bytes).sort((a, b) => a - b)[
          Math.floor(fixtures.length / 2)
        ],
      },
      withReviews: fixtures.filter((f) => f.meta.reviews > 0).length,
      withBriefing: fixtures.filter((f) => f.evidence.briefing).length,
      withCi: fixtures.filter((f) => f.evidence.ci.status !== "unknown").length,
    },
    null,
    2
  ) + "\n"
);
