import { retainedEvidence } from "./explanation-evidence.js";
import { mergeRiskCapacity } from "./budget.js";
import type { Pool } from "pg";
import type { RoutingSettings } from "../../chat/routing-settings.js";
import {
  requestExplanation,
  type ExplanationFailure,
} from "./explanation-client.js";

type Input = { assessmentId: string };
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
type Assessment = {
  head_sha: string;
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
 * Request auth and the browser-only route are the only access controls.
 */
export class RiskExplanations {
  constructor(
    private readonly deps: {
      pool: Pool;
      settings: RoutingSettings;
      transport?: typeof fetch;
    }
  ) {}

  private async find(id: string): Promise<Assessment | undefined> {
    const { rows } = await this.deps.pool.query<Assessment>(
      `SELECT r.head_sha,r.created_at,r.result,s.evidence
       FROM merge_risk_decision_records r
       LEFT JOIN merge_risk_evidence_snapshots s ON s.assessment_id=r.id
       WHERE r.id=$1 AND r.status='ok'`,
      [id]
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
    const assessment = await this.find(input.assessmentId);
    if (!assessment) return { state: "unavailable", reason: "not_found" };
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
