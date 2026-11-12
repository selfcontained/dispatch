import { retainedEvidence } from "./explanation-evidence.js";
import {
  mergeRiskCapacity,
  mergeRiskDailyCap,
  mergeRiskDailyReset,
  refundUnsentCall,
  refusedByProvider,
} from "./budget.js";
import { createHash } from "node:crypto";
import type { AgentPullRequest } from "@dispatch/shared";
import type { Pool } from "pg";
import type { RoutingSettings } from "../../chat/routing-settings.js";
import {
  allFindingsResolved,
  loadReviewEvidence,
  reviewFingerprint,
} from "./sources.js";
import {
  requestExplanation,
  type ExplanationFailure,
} from "./explanation-client.js";

type Input = { agentId: string; url: string; assessmentId: string };
/**
 * `limited` is only ever a capacity decision made before any request:
 * `daily_cap` (shared daily budget used) or `concurrency` (two calls already
 * in flight). Provider/network failures are `failed` with their own reason.
 */
export type ExplanationReply =
  | { state: "ready"; text?: string }
  | { state: "unavailable" | "pending" }
  | {
      state: "limited";
      reason: "daily_cap";
      used: number;
      cap: number;
      resetsAt: string;
    }
  | { state: "limited"; reason: "concurrency" }
  | { state: "failed"; reason: ExplanationFailure | "unknown" };
type Reply = ExplanationReply;
type Snapshot = {
  owner_ids: string[];
  owner_projects: Record<string, string | null>;
  review_digest: string;
  evidence: unknown;
  review_fingerprint: string;
  result: Record<string, unknown>;
  head_sha: string;
};
/** Human-click entry point only; no connection to polling, scoring or MCP. */
export class RiskExplanations {
  constructor(
    private readonly deps: {
      pool: Pool;
      settings: RoutingSettings;
      inventory: { get(id: string): AgentPullRequest[] };
      transport?: typeof fetch;
      env?: NodeJS.ProcessEnv;
    }
  ) {}
  private async eligible(input: Input): Promise<Snapshot | null> {
    const config = await this.deps.settings.configuration();
    if (!config.mergeRiskEnabled || !config.apiKey) return null;
    const pr = this.deps.inventory
      .get(input.agentId)
      .find((p) => p.url === input.url);
    if (
      !pr ||
      !["Open", "Draft"].includes(pr.status) ||
      pr.mergeRisk?.displayState ||
      pr.mergeRisk?.status !== "ok" ||
      pr.mergeRisk.assessmentId !== input.assessmentId ||
      !pr.ci?.headSha ||
      pr.ci.headSha !== pr.mergeRisk.headSha
    )
      return null;
    const { rows } = await this.deps.pool.query<Snapshot>(
      `SELECT s.*,r.review_fingerprint,r.result,r.head_sha FROM merge_risk_evidence_snapshots s
       JOIN merge_risk_decision_records r ON r.id=s.assessment_id
       WHERE r.id=$1 AND r.url=$2 AND r.status='ok' AND r.head_sha=$3`,
      [input.assessmentId, input.url, pr.ci.headSha]
    );
    const row = rows[0];
    if (!row || !row.owner_ids.includes(input.agentId)) return null;
    // Evidence can contain reviews from multiple owners. Never expose it across projects.
    const owners = await this.deps.pool.query<{
      id: string;
      project_id: string | null;
    }>("SELECT id,project_id FROM agents WHERE id=ANY($1::text[])", [
      row.owner_ids,
    ]);
    const caller = owners.rows.find((a) => a.id === input.agentId);
    if (
      !caller ||
      owners.rows.length !== row.owner_ids.length ||
      owners.rows.some(
        (a) =>
          row.owner_projects[a.id] !== a.project_id ||
          (a.id !== caller.id &&
            (!caller.project_id || a.project_id !== caller.project_id))
      )
    )
      return null;
    const reviews = await loadReviewEvidence(this.deps.pool, row.owner_ids, {
      settlementProvenance: true,
    });
    if (
      !allFindingsResolved(reviews) ||
      reviewFingerprint(reviews) !== row.review_fingerprint ||
      createHash("sha256").update(JSON.stringify(reviews)).digest("hex") !==
        row.review_digest
    )
      return null;
    return config === (await this.deps.settings.configuration()) ? row : null;
  }
  async explain(input: Input): Promise<Reply> {
    if (
      !/^\d{1,19}$/.test(input.assessmentId) ||
      BigInt(input.assessmentId) > 9223372036854775807n
    )
      return { state: "unavailable" };
    const snapshot = await this.eligible(input);
    if (!snapshot) return { state: "unavailable" };
    const client = await this.deps.pool.connect();
    let run = false;
    try {
      await client.query("BEGIN");
      const capacity = await mergeRiskCapacity(
        client,
        this.deps.env ?? process.env
      );
      const stored = (
        await client.query<{ status: string; result: { text?: string } }>(
          "SELECT status,result FROM merge_risk_explanations WHERE assessment_id=$1",
          [input.assessmentId]
        )
      ).rows[0];
      if (stored?.status === "ok" || stored?.status === "pending") {
        await client.query("COMMIT");
        if (!(await this.eligible(input))) return { state: "unavailable" };
        return stored.status === "ok"
          ? { state: "ready", text: stored.result.text }
          : { state: "pending" };
      }
      if (capacity !== "pending") {
        const used = (
          await client.query<{ calls: number }>(
            "SELECT calls FROM merge_risk_decision_daily WHERE day=(now() AT TIME ZONE 'UTC')::date"
          )
        ).rows[0]?.calls;
        await client.query("COMMIT");
        return capacity === "skipped_daily_cap"
          ? {
              state: "limited",
              reason: "daily_cap",
              used: used ?? 0,
              cap: mergeRiskDailyCap(this.deps.env ?? process.env),
              resetsAt: mergeRiskDailyReset(),
            }
          : { state: "limited", reason: "concurrency" };
      }
      await client.query(
        "INSERT INTO merge_risk_explanations(assessment_id,status) VALUES($1,'pending') ON CONFLICT(assessment_id) DO UPDATE SET status='pending',created_at=now()",
        [input.assessmentId]
      );
      await client.query(
        "UPDATE merge_risk_decision_daily SET calls=calls+1 WHERE day=(now() AT TIME ZONE 'UTC')::date"
      );
      await client.query("COMMIT");
      run = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!run) return { state: "failed", reason: "unknown" };
    const config = await this.deps.settings.configuration();
    if (
      !(await this.eligible(input)) ||
      config !== (await this.deps.settings.configuration()) ||
      !config.mergeRiskEnabled ||
      !config.apiKey
    ) {
      await this.finish(input.assessmentId, "stale", {});
      await refundUnsentCall(
        this.deps.pool,
        "merge_risk_explanations",
        input.assessmentId
      );
      return { state: "unavailable" };
    }
    const result = await requestExplanation(
      config.apiKey,
      explanationInput(
        retainedEvidence(snapshot.evidence, config.apiKey),
        snapshot.result
      ),
      this.deps.transport
    );
    const current =
      !!(await this.eligible(input)) &&
      config === (await this.deps.settings.configuration());
    // Oversized input never leaves Dispatch; a refused request did no billable work.
    if (
      result.status === "error" &&
      (result.reason === "oversized" || refusedByProvider(result.httpStatus))
    )
      await refundUnsentCall(
        this.deps.pool,
        "merge_risk_explanations",
        input.assessmentId
      );
    // Stale work retains only accounting, never publishes generated text.
    const { text, ...accounting } = result;
    await this.finish(input.assessmentId, current ? result.status : "stale", {
      ...accounting,
      ...(current && text ? { text } : {}),
    });
    return !current
      ? { state: "unavailable" }
      : result.status === "ok"
        ? { state: "ready", text }
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

/** Shared by the click path and offline payload inspection. No diagnostics. */
export function explanationInput(
  evidence: unknown,
  result: Record<string, unknown>
) {
  return {
    evidence: followupEvidence(evidence),
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
