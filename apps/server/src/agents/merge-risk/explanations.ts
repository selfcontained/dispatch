import { githubPullRequestUrl } from "../pull-request-reader.js";
import { mergeRiskScope, type MergeRiskGitHubSource } from "./github-source.js";
import { retainedEvidence } from "./explanation-evidence.js";
import { mergeRiskCapacity } from "./budget.js";
import { readAssessedDiff } from "./explanation-diff.js";
import type { Pool } from "pg";
import type { RoutingSettings } from "../../chat/routing-settings.js";
import {
  EXPLANATION_VERSION,
  requestExplanation,
  type ExplanationFailure,
} from "./explanation-client.js";

type Input = { assessmentId: string; url?: string; runnerId?: string | null };
/**
 * Why no explanation could start. Safe to show and log; never private data.
 * `not_found` means no completed assessment has that id (unknown or pruned).
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
type ExistingReply = Extract<Reply, { state: "pending" | "ready" | "limited" }>;
type Assessment = {
  url: string;
  head_sha: string;
  base_sha: string | null;
  created_at: Date;
  result: Record<string, unknown>;
  /** Null when the record predates evidence retention or retention failed. */
  evidence: unknown;
};

/**
 * Human-click entry point only; no connection to polling, scoring or MCP.
 *
 * Explains one saved assessment by id, as it was made. Nothing about the
 * PR's current head, reviews, status or the in-memory inventory gates it.
 * The requesting placement must still be able to read the PR with the
 * credential that supplied the assessment.
 */
export class RiskExplanations {
  constructor(
    private readonly deps: {
      pool: Pool;
      settings: RoutingSettings;
      transport?: typeof fetch;
      github?: Pick<MergeRiskGitHubSource, "details" | "diff">;
      /** Hunks for the assessed commit; injectable so tests never call gh. */
      readDiff?: typeof readAssessedDiff;
    }
  ) {}

  private async find(
    id: string,
    url: string | null,
    scope: string,
    includeHistorical: boolean
  ): Promise<Assessment | undefined> {
    const { rows } = await this.deps.pool.query<Assessment>(
      `SELECT r.url,r.head_sha,r.base_sha,r.created_at,r.result,s.evidence
       FROM merge_risk_decision_records r
       LEFT JOIN merge_risk_evidence_snapshots s ON s.assessment_id=r.id
       WHERE r.id=$1 AND r.status='ok' AND ($2::text IS NULL OR r.url=$2)
         AND (r.evidence_scope=$3 OR ($4 AND r.evidence_scope=''))`,
      [id, url, scope, includeHistorical]
    );
    return rows[0];
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
    const github = this.deps.github;
    const runnerId = input.runnerId ?? null;
    const url = input.url ? githubPullRequestUrl(input.url) : null;
    const details = github && url ? await github.details(runnerId, url) : null;
    if ((github && !details) || (!github && runnerId !== null))
      return { state: "unavailable", reason: "not_found" };
    const scope = details
      ? mergeRiskScope(runnerId, details.credentialContext)
      : "";
    const authorized = async () =>
      !details ||
      (!!url &&
        (await github?.details(runnerId, url))?.credentialContext ===
          details.credentialContext);
    const assessment = await this.find(
      input.assessmentId,
      url,
      scope,
      runnerId === null
    );
    if (!assessment) return { state: "unavailable", reason: "not_found" };
    const limitedEvidence = assessment.evidence == null;
    // Settings are re-read after every await; a change aborts before spend.
    const unchanged = async () =>
      config === (await this.deps.settings.configuration());
    if (!(await unchanged()))
      return { state: "unavailable", reason: "config_changed" };
    const existing = await this.reserve(input.assessmentId);
    if (existing) {
      if (existing.state === "limited" || (await authorized())) return existing;
      return { state: "unavailable", reason: "not_found" };
    }
    // Hunks require saved evidence and both commits from the assessment.
    const diff =
      limitedEvidence || !assessment.base_sha
        ? null
        : github && details
          ? await github.diff(
              runnerId,
              assessment.url,
              assessment.base_sha,
              assessment.head_sha,
              details.credentialContext,
              assessment.evidence
            )
          : await (this.deps.readDiff ?? readAssessedDiff)(
              assessment.url,
              assessment.base_sha,
              assessment.head_sha,
              assessment.evidence
            ).catch(() => null);
    if (!(await authorized())) {
      await this.finish(input.assessmentId, "stale", { reason: "not_found" });
      return { state: "unavailable", reason: "not_found" };
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
        },
        diff ? retainedEvidence(diff, config.apiKey) : undefined
      ),
      this.deps.transport
    );
    const stillAuthorized = await authorized();
    const current = stillAuthorized && (await unchanged());
    // Results from replaced settings retain only accounting, never text.
    const { text, ...accounting } = result;
    await this.finish(input.assessmentId, current ? result.status : "stale", {
      ...accounting,
      ...(current
        ? {}
        : { reason: stillAuthorized ? "config_changed" : "not_found" }),
      ...(current && text ? { text } : {}),
      ...(limitedEvidence ? { limitedEvidence: true } : {}),
    });
    if (!current)
      return {
        state: "unavailable",
        reason: stillAuthorized ? "config_changed" : "not_found",
      };
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
  private async reserve(
    assessmentId: string
  ): Promise<ExistingReply | undefined> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const capacity = await mergeRiskCapacity(client);
      const stored = (
        await client.query<{
          status: string;
          result: {
            text?: string;
            limitedEvidence?: boolean;
            version?: string;
          };
        }>(
          "SELECT status,result FROM merge_risk_explanations WHERE assessment_id=$1",
          [assessmentId]
        )
      ).rows[0];
      let reply: ExistingReply | undefined;
      // An explanation from an older prompt/model is regenerated.
      if (stored?.status === "pending") {
        reply = { state: "pending" };
      } else if (
        stored?.status === "ok" &&
        stored.result.version === EXPLANATION_VERSION
      ) {
        reply = {
          state: "ready",
          text: stored.result.text,
          ...(stored.result.limitedEvidence
            ? { limitedEvidence: true as const }
            : {}),
        };
      } else if (capacity !== "pending") {
        reply = { state: "limited", reason: "concurrency" };
      } else {
        await client.query(
          "INSERT INTO merge_risk_explanations(assessment_id,status) VALUES($1,'pending') ON CONFLICT(assessment_id) DO UPDATE SET status='pending',created_at=now()",
          [assessmentId]
        );
      }
      await client.query("COMMIT");
      return reply;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
  assessed?: { assessedCommit: string; assessedAt: string },
  diff?: unknown
) {
  return {
    context: {
      ...(assessed ?? {}),
      evidenceRetained: evidence != null,
    },
    evidence: evidence == null ? null : followupEvidence(evidence),
    ...(diff ? { diff } : {}),
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
