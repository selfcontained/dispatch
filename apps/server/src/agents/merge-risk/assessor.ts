import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { pullRequestCredentialContext } from "../pull-request-reader.js";
import { mergeRiskScope, type MergeRiskGitHubSource } from "./github-source.js";
import { mergeRiskCapacity } from "./budget.js";
/**
 * Produces one merge-risk recommendation per (pull request, head, review
 * state) and remembers it. Called by the PR refresher after each GitHub read;
 * it decides whether a provider request is warranted and otherwise returns
 * what is already stored. Never merges, approves, or blocks anything.
 */
import type { AgentPullRequest, MergeRiskSummary } from "@dispatch/shared";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import {
  retainedEvidence,
  explanationSnapshot,
} from "./explanation-evidence.js";
import {
  requestDecisions,
  DECISIONS_MODEL,
} from "../../chat/decisions-client.js";
import type { RoutingSettings } from "../../chat/routing-settings.js";
import {
  loadCodeowners,
  type CodeownersConfig,
} from "../../personas/codeowners.js";
import {
  buildMergeRiskEvidence,
  MergeRiskEvidenceTooLarge,
} from "./evidence.js";
import {
  assessMergeRisk,
  MERGE_RISK_PROMPT_VERSION,
  MERGE_RISK_QUESTIONS,
  type MergeRiskAssessment,
} from "./policy.js";
import {
  allFindingsResolved,
  loadBriefing,
  loadReviewEvidence,
  reviewFingerprint,
} from "./sources.js";

type Options = {
  pool: Pool;
  settings: RoutingSettings;
  /** Checkout root for an owning agent, used to read its ownership map. */
  agentRoot: (agentId: string) => Promise<string | null>;
  remoteOwners?: (
    agentId: string,
    runnerId: string
  ) => Promise<CodeownersConfig | null>;
  /** PR details as the tracking agent's runner reads them. */
  github: Pick<MergeRiskGitHubSource, "details">;
  transport?: typeof fetch;
  warn?: (error: unknown) => void;
};

type Row = {
  id: string;
  status: string;
  head_sha: string;
  prompt_version: string;
  created_at: Date;
  result: Record<string, unknown>;
};

export class MergeRiskAssessor {
  constructor(private readonly options: Options) {}

  /**
   * The recommendation to show for this PR observation.
   *
   * Nothing runs while the setting is off or no token is stored: no queries,
   * no provider calls, and no recommendation is returned, so previously
   * recorded verdicts disappear from the UI until it is turned back on.
   *
   * Current recommendations require the existing head/review gate. Other
   * observations expose display-only lifecycle states with separately labeled
   * historical context. Progress publication does not reserve another call.
   */
  async assess(
    url: string,
    pr: AgentPullRequest,
    ownerAgentIds: string[],
    onProgress?: (risk: MergeRiskSummary) => void,
    runnerId: string | null = null
  ): Promise<MergeRiskSummary | undefined> {
    const headSha = pr.ci?.headSha ?? "";
    // Off means off: no reads, no lookups, and no recommendation shown.
    const config = await this.options.settings.configuration();
    if (!config.mergeRiskEnabled || !config.apiKey)
      return displaySummary("disabled", headSha);
    // Records are keyed by the credential the PR was observed with; a runner
    // whose read names none has nothing it may reuse or record.
    const scope = mergeRiskScope(runnerId, pullRequestCredentialContext(pr));
    if (scope === null) return displaySummary("unavailable", headSha);
    const previous = await this.history(url, scope);
    const display = (state: NonNullable<MergeRiskSummary["displayState"]>) => ({
      ...displaySummary(state, headSha),
      ...(previous ? { previous } : {}),
    });
    if (!headSha) return display("unavailable");
    const reviews = await loadReviewEvidence(this.options.pool, ownerAgentIds, {
      settlementProvenance: true,
    });
    const fingerprint = reviewFingerprint(reviews);
    if (pr.status === "Merged")
      return (await this.latest(url, headSha, scope)) ?? display("not_ready");
    const gateHolds =
      (pr.status === "Open" || pr.status === "Draft") &&
      allFindingsResolved(reviews);
    if (!gateHolds)
      return display(
        pr.status !== "Open" && pr.status !== "Draft"
          ? "not_ready"
          : "waiting_review"
      );
    const stored = await this.latest(url, headSha, scope, fingerprint);
    if (stored)
      return stored.status === "ok"
        ? stored
        : {
            ...stored,
            displayState: stored.displayState ?? "failure",
            ...(previous ? { previous } : {}),
          };
    const id = await this.reserve(url, headSha, fingerprint, scope);
    if (!id) {
      const record = await this.options.pool.query<{ status: string }>(
        "SELECT status FROM merge_risk_decision_records WHERE url=$1 AND head_sha=$2 AND review_fingerprint=$3 AND evidence_scope=$4 ORDER BY created_at DESC,id DESC LIMIT 1",
        [url, headSha, fingerprint, scope]
      );
      return display(
        record.rows[0]?.status === "pending"
          ? "evaluating"
          : record.rows[0]?.status === "skipped_concurrency"
            ? "capacity"
            : "deferred"
      );
    }
    onProgress?.(display("evaluating"));
    try {
      let details;
      try {
        details = await this.options.github.details(runnerId, url);
      } catch (error) {
        // A runner that cannot answer is asked again on the next read; a
        // local read falls back in process, so it never lands here.
        if (
          !(error instanceof RunnerCallError) ||
          (error.code !== "unavailable" && error.code !== "unknown_outcome")
        )
          throw error;
        await this.finish(id, "skipped_runner_unavailable", {});
        return display("unavailable");
      }
      if (!details || details.headRefOid !== headSha) {
        await this.finish(id, "skipped_stale_head", {});
        return display("unavailable");
      }
      // The evidence must come from the credential the record is keyed by.
      if (mergeRiskScope(runnerId, details.credentialContext) !== scope) {
        await this.finish(id, "skipped_credential_changed", {});
        return displaySummary("unavailable", headSha);
      }
      if (details.baseRefOid)
        await this.options.pool.query(
          "UPDATE merge_risk_decision_records SET base_sha=$2 WHERE id=$1",
          [id, details.baseRefOid]
        );
      const owners = await this.owners(ownerAgentIds, runnerId);
      const evidence = buildMergeRiskEvidence({
        pullRequest: {
          number: details.number,
          title: details.title,
          body: details.body,
          baseRef: details.baseRefName,
          headRef: details.headRefName,
          additions: details.additions,
          deletions: details.deletions,
        },
        files: details.files,
        owners,
        briefing: await loadBriefing(this.options.pool, ownerAgentIds),
        reviews,
        ci:
          pr.ci?.availability === "available"
            ? {
                status: pr.ci.summary.status,
                total: pr.ci.summary.total,
                passed: pr.ci.summary.passed,
                failed: pr.ci.summary.failed,
                pending: pr.ci.summary.pending,
              }
            : null,
      });
      // The setting can change while evidence is being gathered.
      if (!(await this.options.settings.configuration()).mergeRiskEnabled) {
        await this.finish(id, "skipped_config_changed", {});
        return displaySummary("disabled", headSha);
      }
      await this.options.pool
        .query(
          `INSERT INTO merge_risk_evidence_snapshots(assessment_id,owner_ids,review_digest,evidence,owner_projects)
         VALUES($1,$2,$3,$4,coalesce((SELECT jsonb_object_agg(id, project_id) FROM agents WHERE id=ANY($2::text[])),'{}'::jsonb)) ON CONFLICT DO NOTHING`,
          [
            id,
            ownerAgentIds,
            createHash("sha256").update(JSON.stringify(reviews)).digest("hex"),
            JSON.stringify(
              retainedEvidence(
                explanationSnapshot(evidence, reviews),
                config.apiKey
              )
            ),
          ]
        )
        .catch(() => {
          // Retention failure must not change scoring or log private payloads.
          this.options.warn?.(
            new Error("Merge-risk evidence snapshot unavailable.")
          );
        });
      const response = await requestDecisions(
        config.apiKey,
        evidence as unknown as Record<string, unknown>,
        MERGE_RISK_QUESTIONS,
        { transport: this.options.transport, timeoutMs: 20_000 }
      );
      const assessment = assessMergeRisk(response.status, response.answers);
      await this.finish(id, response.status, {
        ...serialize(assessment),
        usage: response.usage,
        latencyMs: response.latencyMs,
        ...(response.httpStatus === undefined
          ? {}
          : { httpStatus: response.httpStatus }),
      });
    } catch (error) {
      this.options.warn?.(error);
      await this.finish(
        id,
        error instanceof MergeRiskEvidenceTooLarge
          ? "skipped_oversized"
          : "error",
        {}
      ).catch(() => {});
    }
    const finalConfig = await this.options.settings.configuration();
    if (!finalConfig.mergeRiskEnabled || !finalConfig.apiKey)
      return displaySummary("disabled", headSha);
    const result = await this.latest(url, headSha, scope, fingerprint);
    return result?.status === "ok"
      ? result
      : {
          ...display("failure"),
          ...(result
            ? {
                status: result.status,
                displayState: result.displayState ?? "failure",
              }
            : {}),
        };
  }

  private async history(
    url: string,
    scope: string
  ): Promise<MergeRiskSummary | undefined> {
    const rows = await this.options.pool.query<Row>(
      "SELECT id, status, head_sha, prompt_version, created_at, result FROM merge_risk_decision_records WHERE url=$1 AND evidence_scope=$2 AND status = 'ok' ORDER BY created_at DESC,id DESC LIMIT 1",
      [url, scope]
    );
    return rows.rows[0] ? toSummary(rows.rows[0]) : undefined;
  }

  private async owners(
    agentIds: string[],
    runnerId: string | null
  ): Promise<CodeownersConfig | null> {
    for (const agentId of agentIds) {
      try {
        if (runnerId !== null) {
          const config = await this.options.remoteOwners?.(agentId, runnerId);
          if (config) return config;
          continue;
        }
        const root = await this.options.agentRoot(agentId);
        if (root) return await loadCodeowners(root);
      } catch {
        // A missing or invalid map leaves subsystems empty; the file list still carries the paths.
      }
    }
    return null;
  }

  private async latest(
    url: string,
    headSha: string,
    scope: string,
    fingerprint?: string
  ): Promise<MergeRiskSummary | undefined> {
    const rows = await this.options.pool.query<Row>(
      `SELECT id, status, head_sha, prompt_version, created_at, result FROM merge_risk_decision_records
        WHERE url = $1 AND head_sha = $2 AND ($3::text IS NULL OR review_fingerprint = $3)
          AND evidence_scope = $4
          AND status NOT IN ('pending') AND status NOT LIKE 'skipped%'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [url, headSha, fingerprint ?? null, scope]
    );
    const row = rows.rows[0];
    return row ? toSummary(row) : undefined;
  }

  private async reserve(
    url: string,
    headSha: string,
    fingerprint: string,
    scope: string
  ) {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const status = await mergeRiskCapacity(client);
      // A capacity skip is a transient outcome, not an assessment: once a slot
      // frees, the same observation reserves again. 'skipped_daily_cap' rows
      // predate the removal of Dispatch's daily cap and revive the same way;
      // before this, a skipped head showed its limit forever.
      const record = await client.query<{ id: string }>(
        `INSERT INTO merge_risk_decision_records(url,head_sha,review_fingerprint,status,prompt_version,result,evidence_scope,base_sha)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(url,head_sha,review_fingerprint,evidence_scope) DO UPDATE
           SET status=EXCLUDED.status,created_at=now(),prompt_version=EXCLUDED.prompt_version,result=EXCLUDED.result,base_sha=EXCLUDED.base_sha
           WHERE merge_risk_decision_records.status IN ('skipped_daily_cap','skipped_concurrency','skipped_credential_changed','skipped_runner_unavailable')
             AND merge_risk_decision_records.status <> EXCLUDED.status
         RETURNING id`,
        [
          url,
          headSha,
          fingerprint,
          status,
          MERGE_RISK_PROMPT_VERSION,
          JSON.stringify({ model: DECISIONS_MODEL }),
          scope,
          null,
        ]
      );
      await client.query("COMMIT");
      return record.rows[0] && status === "pending"
        ? record.rows[0].id
        : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async finish(
    id: string,
    status: string,
    result: Record<string, unknown>
  ) {
    await this.options.pool.query(
      "UPDATE merge_risk_decision_records SET status=$2,result=result || $3::jsonb WHERE id=$1",
      [id, status, JSON.stringify(result)]
    );
  }

  async prune() {
    await this.options.pool.query(
      "DELETE FROM merge_risk_decision_records WHERE created_at < now() - interval '14 days' OR id IN (SELECT id FROM merge_risk_decision_records ORDER BY created_at DESC,id DESC OFFSET 2000)"
    );
  }
}

function serialize(a: MergeRiskAssessment) {
  const p = (value: string) =>
    a.needsHuman?.probabilities.find((x) => x.value === value)?.probability ??
    null;
  return {
    verdict: a.verdict,
    changeRisk: a.changeRisk,
    changeRiskLabel: a.changeRiskLabel,
    reviewAdequate: a.reviewAdequate,
    descriptionMatches: a.descriptionMatches,
    newSurface: a.newSurface,
    routineProbability: p("routine"),
    humanReviewProbability: p("human_review"),
    confidence: a.needsHuman?.confidence ?? null,
  };
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
function toSummary(row: Row): MergeRiskSummary {
  const r = row.result;
  const verdict = r.verdict;
  return {
    assessmentId: row.id,
    ...(r.httpStatus === 429 ? { displayState: "rate_limited" as const } : {}),
    verdict:
      verdict === "routine" || verdict === "human_review" ? verdict : "abstain",
    changeRisk: num(r.changeRisk),
    changeRiskLabel:
      typeof r.changeRiskLabel === "string" ? r.changeRiskLabel : null,
    reviewAdequate: num(r.reviewAdequate),
    descriptionMatches: num(r.descriptionMatches),
    newSurface: num(r.newSurface),
    routineProbability: num(r.routineProbability),
    humanReviewProbability: num(r.humanReviewProbability),
    confidence: num(r.confidence),
    status: row.status,
    promptVersion: row.prompt_version,
    headSha: row.head_sha,
    assessedAt: new Date(row.created_at).toISOString(),
  };
}

function displaySummary(
  displayState: NonNullable<MergeRiskSummary["displayState"]>,
  headSha: string
): MergeRiskSummary {
  return {
    displayState,
    headSha,
    verdict: "abstain",
    status: "",
    promptVersion: "",
    assessedAt: "",
    changeRisk: null,
    changeRiskLabel: null,
    reviewAdequate: null,
    descriptionMatches: null,
    newSurface: null,
    routineProbability: null,
    humanReviewProbability: null,
    confidence: null,
  };
}
