import { retainedEvidence } from "./explanation-evidence.js";
import { mergeRiskCapacity } from "./budget.js";
import type { Pool } from "pg";
import type { RoutingSettings } from "../../chat/routing-settings.js";
import { githubPullRequestUrl } from "../pull-request-reader.js";
import {
  requestExplanation,
  type ExplanationFailure,
} from "./explanation-client.js";

type Input = { agentId: string; url: string; assessmentId: string };
/**
 * Why no explanation could start. Safe to show and log; never private data.
 * `not_found` covers unknown, pruned and unauthorized records alike so an
 * id guess learns nothing about other agents' assessments.
 */
export type ExplanationUnavailable =
  | "disabled"
  | "not_found"
  | "config_changed";
/**
 * `limited` only means two provider calls were already in flight; Dispatch
 * has no daily or token limit. Provider/network failures, including the
 * key's own provider rate limits, are `failed` with their reason.
 */
export type ExplanationReply =
  | { state: "ready"; text?: string; limitedEvidence?: true }
  | { state: "unavailable"; reason: ExplanationUnavailable }
  | { state: "pending" }
  | { state: "limited"; reason: "concurrency" }
  | { state: "failed"; reason: ExplanationFailure | "unknown" };
type Reply = ExplanationReply;
type Assessment = {
  head_sha: string;
  created_at: Date;
  result: Record<string, unknown>;
  /** Null when the record predates evidence retention or retention failed. */
  evidence: unknown;
};
type Record_ = Assessment & {
  owner_ids: string[] | null;
  owner_projects: Record<string, string | null> | null;
};
type Access = { ok: true; assessment: Assessment } | { ok: false };

/**
 * Human-click entry point only; no connection to polling, scoring or MCP.
 *
 * Explains one saved assessment by id, as it was made. Nothing about the
 * PR's current head, reviews, status or the in-memory inventory gates it:
 * access rests on durable ownership recorded with the assessment.
 */
export class RiskExplanations {
  constructor(
    private readonly deps: {
      pool: Pool;
      settings: RoutingSettings;
      transport?: typeof fetch;
    }
  ) {}

  /**
   * Snapshot records: the caller must be one of the owners recorded at
   * assessment time, in the project recorded then, and every recorded owner
   * must share that project (evidence can hold several owners' reviews).
   * Owners archived or purged since then do not matter; recorded projects do.
   *
   * Records without a snapshot carry no evidence, only scores; the caller
   * must itself have posted this pull request.
   */
  private async access(input: Input): Promise<Access> {
    const { rows } = await this.deps.pool.query<Record_>(
      `SELECT r.head_sha,r.created_at,r.result,s.owner_ids,s.owner_projects,s.evidence
       FROM merge_risk_decision_records r
       LEFT JOIN merge_risk_evidence_snapshots s ON s.assessment_id=r.id
       WHERE r.id=$1 AND r.url=$2 AND r.status='ok'`,
      [input.assessmentId, input.url]
    );
    const row = rows[0];
    if (!row) return { ok: false };
    const caller = (
      await this.deps.pool.query<{ project_id: string | null }>(
        "SELECT project_id FROM agents WHERE id=$1 AND deleted_at IS NULL",
        [input.agentId]
      )
    ).rows[0];
    if (!caller) return { ok: false };
    const assessment = {
      head_sha: row.head_sha,
      created_at: row.created_at,
      result: row.result,
      evidence: null as unknown,
    };
    if (row.owner_ids) {
      const recorded = row.owner_projects ?? {};
      const project = recorded[input.agentId];
      const others = row.owner_ids.filter((id) => id !== input.agentId);
      if (
        !row.owner_ids.includes(input.agentId) ||
        project === undefined ||
        project !== caller.project_id ||
        (others.length > 0 &&
          (project === null || others.some((id) => recorded[id] !== project)))
      )
        return { ok: false };
      return {
        ok: true,
        assessment: { ...assessment, evidence: row.evidence },
      };
    }
    return (await this.postedPullRequest(input.agentId, input.url))
      ? { ok: true, assessment }
      : { ok: false };
  }

  /** Same durable source the PR inventory reads, without needing it loaded. */
  private async postedPullRequest(agentId: string, url: string) {
    const { rows } = await this.deps.pool.query<{
      attachments: { type?: string; url?: string }[];
    }>(
      `SELECT attachments FROM blocks
       WHERE author_agent_id=$1 AND attachments @> '[{"type":"pr"}]'::jsonb
       AND NOT (COALESCE(data, '{}'::jsonb) ? 'pullRequestTransition')`,
      [agentId]
    );
    return rows.some((row) =>
      row.attachments.some(
        (a) =>
          a.type === "pr" &&
          typeof a.url === "string" &&
          (githubPullRequestUrl(a.url) ?? a.url) === url
      )
    );
  }

  async explain(input: Input): Promise<Reply> {
    if (
      !/^\d{1,19}$/.test(input.assessmentId) ||
      BigInt(input.assessmentId) > 9223372036854775807n
    )
      return { state: "unavailable", reason: "not_found" };
    const config = await this.deps.settings.configuration();
    if (!config.mergeRiskEnabled || !config.apiKey)
      return { state: "unavailable", reason: "disabled" };
    const granted = await this.access(input);
    if (!granted.ok) return { state: "unavailable", reason: "not_found" };
    const { assessment } = granted;
    const limitedEvidence = assessment.evidence == null;
    // Settings are re-read after every await; a change aborts before spend.
    const unchanged = async () =>
      config === (await this.deps.settings.configuration());
    if (!(await unchanged()))
      return { state: "unavailable", reason: "config_changed" };
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const capacity = await mergeRiskCapacity(client);
      const stored = (
        await client.query<{
          status: string;
          result: { text?: string; limitedEvidence?: boolean };
        }>(
          "SELECT status,result FROM merge_risk_explanations WHERE assessment_id=$1",
          [input.assessmentId]
        )
      ).rows[0];
      if (stored?.status === "ok" || stored?.status === "pending") {
        await client.query("COMMIT");
        if (stored.status === "pending") return { state: "pending" };
        return {
          state: "ready",
          text: stored.result.text,
          ...(stored.result.limitedEvidence
            ? { limitedEvidence: true as const }
            : {}),
        };
      }
      if (capacity !== "pending") {
        await client.query("COMMIT");
        return { state: "limited", reason: "concurrency" };
      }
      await client.query(
        "INSERT INTO merge_risk_explanations(assessment_id,status) VALUES($1,'pending') ON CONFLICT(assessment_id) DO UPDATE SET status='pending',created_at=now()",
        [input.assessmentId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!(await unchanged())) {
      await this.finish(input.assessmentId, "stale", {
        reason: "config_changed",
      });
      return { state: "unavailable", reason: "config_changed" };
    }
    const result = await requestExplanation(
      config.apiKey,
      explanationInput(
        limitedEvidence
          ? null
          : retainedEvidence(assessment.evidence, config.apiKey),
        assessment.result,
        {
          assessedCommit: assessment.head_sha,
          assessedAt: new Date(assessment.created_at).toISOString(),
        }
      ),
      this.deps.transport
    );
    const current = await unchanged();
    // Results from replaced settings retain only accounting, never text.
    const { text, ...accounting } = result;
    await this.finish(input.assessmentId, current ? result.status : "stale", {
      ...accounting,
      ...(current ? {} : { reason: "config_changed" }),
      ...(current && text ? { text } : {}),
      ...(limitedEvidence ? { limitedEvidence: true } : {}),
    });
    if (!current) return { state: "unavailable", reason: "config_changed" };
    return result.status === "ok"
      ? {
          state: "ready",
          text,
          ...(limitedEvidence ? { limitedEvidence } : {}),
        }
      : {
          state: "failed",
          reason: result.status === "error" ? result.reason : "unknown",
        };
  }
  private async finish(id: string, status: string, result: unknown) {
    await this.deps.pool.query(
      `UPDATE merge_risk_explanations SET status=$2,result=(result || $3::jsonb) ||
      jsonb_build_object('attempts',coalesce(result->'attempts','[]'::jsonb) || jsonb_build_array(($3::jsonb - 'text') || jsonb_build_object('attemptedAt',created_at)))
      WHERE assessment_id=$1`,
      [id, status, JSON.stringify(result)]
    );
  }
}

/** Keep bounded technical findings; withhold identities, launch text and summaries. */
export function followupEvidence(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const evidence = raw as Record<string, unknown>;
  return {
    ...evidence,
    briefing: "[private briefing withheld]",
    reviews: Array.isArray(evidence.reviews)
      ? evidence.reviews.map((raw) => {
          const review = raw as Record<string, unknown>;
          return {
            ...review,
            reviewer: "reviewer",
            summary: "[summary withheld]",
            findings: Array.isArray(review.findings)
              ? review.findings.map((raw) => {
                  const finding = raw as Record<string, unknown>;
                  return {
                    ...finding,
                    settlement_by: finding.settlement_by ?? "unknown",
                    note:
                      finding.settlement_by === "reviewer" ||
                      finding.settlement_by === "person"
                        ? finding.note
                        : "[unverified resolution note withheld]",
                  };
                })
              : [],
          };
        })
      : [],
  };
}

/**
 * Shared by the click path and offline payload inspection. No diagnostics.
 * `evidence: null` means none was retained: the model is told so rather than
 * handed an empty object it could mistake for "no files, no reviews".
 */
export function explanationInput(
  evidence: unknown,
  result: Record<string, unknown>,
  assessed?: { assessedCommit: string; assessedAt: string }
) {
  return {
    context: {
      ...(assessed ?? {}),
      evidenceRetained: evidence != null,
    },
    evidence: evidence == null ? null : followupEvidence(evidence),
    assessment: Object.fromEntries(
      [
        "verdict",
        "changeRisk",
        "routineProbability",
        "humanReviewProbability",
        "changeRiskLabel",
        "reviewAdequate",
        "descriptionMatches",
        "newSurface",
        "confidence",
      ].map((key) => [key, result[key] ?? null])
    ),
  };
}
