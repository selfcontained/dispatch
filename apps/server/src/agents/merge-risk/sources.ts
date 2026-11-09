/**
 * Evidence sources shared by the live assessor and the offline backfill:
 * review blocks addressed to the agents that own a pull request, the launch
 * briefing, and PR details from `gh`. Read-only everywhere.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  runCommand,
  type CommandRunner,
} from "../../shared/lib/run-command.js";
import type { MergeRiskFile, MergeRiskReview } from "./evidence.js";

type ReviewRow = {
  id: string;
  summary: string | null;
  persona: string | null;
  name: string | null;
  blocks: unknown;
};
type FindingRow = {
  data: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
};

/** Reviews posted to any of the owning agents, oldest first, with findings. */
export async function loadReviewEvidence(
  pool: Pool,
  agentIds: string[]
): Promise<MergeRiskReview[]> {
  if (!agentIds.length) return [];
  const reviews = await pool.query<ReviewRow>(
    `SELECT r.id, r.data->>'summary' AS summary, ag.persona, ag.name, r.state->'blocks' AS blocks
       FROM blocks r LEFT JOIN agents ag ON ag.id = r.author_agent_id
      WHERE r.kind = 'review' AND r.to_agent_id = ANY($1::text[])
      ORDER BY r.created_at, r.id`,
    [agentIds]
  );
  const result: MergeRiskReview[] = [];
  for (const review of reviews.rows) {
    const ids = Array.isArray(review.blocks)
      ? review.blocks.filter((id): id is string => typeof id === "string")
      : [];
    const findings = ids.length
      ? (
          await pool.query<FindingRow>(
            `SELECT data, state FROM blocks WHERE kind = 'finding' AND id = ANY($1::uuid[]) ORDER BY created_at, id`,
            [ids]
          )
        ).rows
      : [];
    result.push({
      reviewer: review.persona || review.name || "reviewer",
      summary: review.summary ?? "",
      findings: findings.map((f) => {
        const status = f.state?.status;
        const resolution = f.state?.resolution;
        return {
          title: String(f.data?.title ?? ""),
          severity: String(f.data?.severity ?? "unknown"),
          status:
            status === "resolved"
              ? resolution === "dismissed"
                ? "dismissed"
                : "fixed"
              : "open",
          ...(typeof f.data?.path === "string" ? { path: f.data.path } : {}),
          ...(typeof f.state?.note === "string" ? { note: f.state.note } : {}),
        };
      }),
    });
  }
  return result;
}

/** The first launch briefing among the owning agents, if any. */
export async function loadBriefing(
  pool: Pool,
  agentIds: string[]
): Promise<string> {
  if (!agentIds.length) return "";
  const row = await pool.query<{ text: string }>(
    `SELECT text FROM blocks WHERE kind = 'launch' AND to_agent_id = ANY($1::text[]) ORDER BY created_at, id LIMIT 1`,
    [agentIds]
  );
  return row.rows[0]?.text ?? "";
}

/** Changes when a review arrives or a finding settles; keyed into records. */
export function reviewFingerprint(reviews: MergeRiskReview[]): string {
  const shape = reviews.map((r) => [
    r.reviewer,
    r.findings.map((f) => f.status),
  ]);
  return createHash("sha256")
    .update(JSON.stringify(shape))
    .digest("hex")
    .slice(0, 16);
}

export function allFindingsResolved(reviews: MergeRiskReview[]): boolean {
  return reviews.every((r) => r.findings.every((f) => f.status !== "open"));
}

export type PullRequestDetails = {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  files: MergeRiskFile[];
  statusCheckRollup: unknown;
};

/** `gh pr view` for one canonical GitHub PR URL; null when gh cannot read it. */
export async function readPullRequestDetails(
  url: string,
  run: CommandRunner = runCommand
): Promise<PullRequestDetails | null> {
  const match = new URL(url).pathname.match(
    /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/
  );
  if (!match) return null;
  const result = await run(
    "gh",
    [
      "pr",
      "view",
      match[3]!,
      "--repo",
      `${match[1]}/${match[2]}`,
      "--json",
      "number,title,body,state,isDraft,mergedAt,additions,deletions,baseRefName,headRefName,headRefOid,files,statusCheckRollup",
    ],
    { timeoutMs: 30_000, allowedExitCodes: [0, 1] }
  );
  if (result.exitCode !== 0) return null;
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    number: num(parsed.number),
    title: str(parsed.title),
    body: str(parsed.body),
    state: str(parsed.state),
    isDraft: parsed.isDraft === true,
    mergedAt: typeof parsed.mergedAt === "string" ? parsed.mergedAt : null,
    additions: num(parsed.additions),
    deletions: num(parsed.deletions),
    baseRefName: str(parsed.baseRefName),
    headRefName: str(parsed.headRefName),
    headRefOid: str(parsed.headRefOid),
    files: Array.isArray(parsed.files)
      ? parsed.files.flatMap((f: unknown) => {
          const file = f as Record<string, unknown>;
          return typeof file?.path === "string"
            ? [
                {
                  path: file.path,
                  additions: num(file.additions),
                  deletions: num(file.deletions),
                },
              ]
            : [];
        })
      : [],
    statusCheckRollup: parsed.statusCheckRollup,
  };
}
