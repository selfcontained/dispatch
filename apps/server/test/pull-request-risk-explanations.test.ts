import { retainedEvidence } from "../src/agents/merge-risk/explanation-evidence.js";
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { AgentPullRequest } from "@dispatch/shared";
import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";
import {
  RiskExplanations,
  followupEvidence,
} from "../src/agents/merge-risk/explanations.js";
import {
  explanationUsage,
  requestExplanation,
} from "../src/agents/merge-risk/explanation-client.js";
import { RoutingSettings } from "../src/chat/routing-settings.js";
import { reviewFingerprint } from "../src/agents/merge-risk/sources.js";
let pool: Pool, settings: RoutingSettings, pr: AgentPullRequest, id: string;
const transport = vi.fn<typeof fetch>();
const input = () => ({
  agentId: "explain-owner",
  url: pr.url,
  assessmentId: id,
});
const response = (
  text = "The auth/session.ts change affects session handling. Resolved review findings mitigate correctness risk; product judgment still needs a maintainer. Evidence is limited and this does not approve merging."
) =>
  Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 50,
      total_tokens: 150,
    },
  });
const service = (env: NodeJS.ProcessEnv = {}) =>
  new RiskExplanations({
    pool,
    settings,
    inventory: { get: (agent) => (agent === "explain-owner" ? [pr] : []) },
    transport,
    env,
  });
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES('explain-owner','Owner','/tmp','running')"
  );
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query(
    "TRUNCATE merge_risk_decision_records,merge_risk_decision_daily CASCADE"
  );
  await pool.query("DELETE FROM settings");
  await pool.query(
    "INSERT INTO settings(key,value) VALUES('routing_api_key','synthetic-key'),('merge_risk_mode','active')"
  );
  settings = new RoutingSettings(pool, {});
  id = (
    await pool.query(
      "INSERT INTO merge_risk_decision_records(url,head_sha,review_fingerprint,status,prompt_version,result) VALUES('https://github.com/example/repo/pull/1','abc',$1,'ok','merge-risk-v2',$2) RETURNING id",
      [
        reviewFingerprint([]),
        JSON.stringify({
          verdict: "human_review",
          changeRiskLabel: "high",
          reviewAdequate: 0.9,
        }),
      ]
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO merge_risk_evidence_snapshots(assessment_id,owner_ids,owner_projects,review_digest,evidence) VALUES($1,ARRAY['explain-owner'],'{\"explain-owner\":null}',$2,$3)",
    [
      id,
      createHash("sha256").update("[]").digest("hex"),
      JSON.stringify({
        files: [{ path: "auth/session.ts" }],
        reviews: [],
        briefing: "private launch",
      }),
    ]
  );
  pr = {
    url: "https://github.com/example/repo/pull/1",
    status: "Open",
    title: "Sessions",
    ci: { headSha: "abc" },
    mergeRisk: { assessmentId: id, status: "ok", headSha: "abc" },
  } as AgentPullRequest;
  transport.mockReset();
  transport.mockImplementation(async () => response());
});
it("only explicit requests generate; concurrent requests dedupe and cached reads spend nothing", async () => {
  await settings.configuration(); // Production warms settings before serving requests.
  const svc = service();
  expect(transport).not.toHaveBeenCalled();
  const replies = await Promise.all([
    svc.explain(input()),
    svc.explain(input()),
  ]);
  expect(replies.some((r) => r.state === "ready")).toBe(true);
  expect(replies.every((r) => ["ready", "pending"].includes(r.state))).toBe(
    true
  );
  expect((await svc.explain(input())).state).toBe("ready");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    (await pool.query("SELECT calls FROM merge_risk_decision_daily")).rows[0]
      .calls
  ).toBe(1);
  const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(body).toMatchObject({
    store: false,
    background: false,
    tools: [],
    max_output_tokens: 512,
  });
  expect(JSON.stringify(body)).not.toContain("private launch");
});
it.each([
  "disabled",
  "head",
  "assessment",
  "scope",
  "legacy",
  "project",
  "review",
])("fails closed for %s", async (reason) => {
  if (reason === "disabled") {
    await pool.query(
      "UPDATE settings SET value='off' WHERE key='merge_risk_mode'"
    );
    settings = new RoutingSettings(pool, {});
  }
  if (reason === "head") pr.ci!.headSha = "new";
  if (reason === "assessment") pr.mergeRisk!.assessmentId = "999";
  if (reason === "legacy")
    await pool.query("DELETE FROM merge_risk_evidence_snapshots");
  if (reason === "project")
    await pool.query(
      'UPDATE merge_risk_evidence_snapshots SET owner_projects=\'{"explain-owner":"other"}\''
    );
  if (reason === "review")
    await pool.query(
      "UPDATE merge_risk_evidence_snapshots SET review_digest='changed'"
    );
  expect(
    (
      await service().explain({
        ...input(),
        ...(reason === "scope" ? { agentId: "other" } : {}),
      })
    ).state
  ).toBe("unavailable");
  expect(transport).not.toHaveBeenCalled();
});
it.each(["0", "garbage"])("respects shared cap %s", async (cap) => {
  expect(
    await service({ DISPATCH_MERGE_RISK_DAILY_CAP: cap }).explain(input())
  ).toMatchObject({ state: "limited", reason: "daily_cap", cap: 0 });
  expect(transport).not.toHaveBeenCalled();
});
it("reports a budget spent by automatic assessments with usage and the UTC reset", async () => {
  await pool.query(
    "INSERT INTO merge_risk_decision_daily(day,calls) VALUES((now() AT TIME ZONE 'UTC')::date,25)"
  );
  const reply = await service().explain(input());
  expect(reply).toMatchObject({
    state: "limited",
    reason: "daily_cap",
    used: 25,
    cap: 25,
  });
  const reset = new Date((reply as { resetsAt: string }).resetsAt);
  expect(reset.getUTCHours()).toBe(0);
  expect(reset.getTime()).toBeGreaterThan(Date.now());
  expect(reset.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
  expect(transport).not.toHaveBeenCalled();
  // Next UTC day: the same click succeeds.
  await pool.query("UPDATE merge_risk_decision_daily SET day=day-1");
  expect((await service().explain(input())).state).toBe("ready");
});
it.each([
  [401, "provider_rejected"],
  [403, "provider_rejected"],
  [429, "provider_rate_limited"],
  [500, "provider_error"],
])(
  "reports provider status %s as %s, never as a limit",
  async (status, reason) => {
    transport.mockImplementationOnce(async () =>
      Response.json({ error: "private" }, { status })
    );
    expect(await service().explain(input())).toEqual({
      state: "failed",
      reason,
    });
    const row = (
      await pool.query("SELECT status,result FROM merge_risk_explanations")
    ).rows[0];
    expect(row.status).toBe("error");
    expect(row.result).toMatchObject({ reason, httpStatus: status });
    expect(JSON.stringify(row.result)).not.toContain("private");
    // Refused (401/403/429) requests did no billable work; other errors count.
    expect(
      (await pool.query("SELECT calls FROM merge_risk_decision_daily")).rows[0]
        .calls
    ).toBe(status === 500 ? 1 : 0);
  }
);
it("reports network failures and timeouts by cause", async () => {
  transport.mockImplementationOnce(async () => {
    throw new TypeError("fetch failed");
  });
  expect(await service().explain(input())).toEqual({
    state: "failed",
    reason: "network",
  });
  transport.mockImplementationOnce(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });
  expect(await service().explain(input())).toEqual({
    state: "failed",
    reason: "timeout",
  });
  // Both requests were sent: both stay charged.
  expect(
    (await pool.query("SELECT calls FROM merge_risk_decision_daily")).rows[0]
      .calls
  ).toBe(2);
});
it("returns the reservation when the assessment goes stale before any request", async () => {
  await settings.configuration();
  const svc = service();
  let checks = 0;
  const original = svc["eligible"].bind(svc);
  svc["eligible"] = async (i: Parameters<typeof original>[0]) =>
    ++checks === 2 ? null : original(i);
  expect((await svc.explain(input())).state).toBe("unavailable");
  expect(transport).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT calls FROM merge_risk_decision_daily")).rows[0]
      .calls
  ).toBe(0);
});
it("respects assessor concurrency slots", async () => {
  for (const head of ["one", "two"])
    await pool.query(
      "INSERT INTO merge_risk_decision_records(url,head_sha,review_fingerprint,status,prompt_version) VALUES('other',$1,'r','pending','v')",
      [head]
    );
  expect(await service().explain(input())).toEqual({
    state: "limited",
    reason: "concurrency",
  });
  expect(transport).not.toHaveBeenCalled();
});
it("discards in-flight stale results and retains usage", async () => {
  transport.mockImplementation(async () => {
    pr.ci!.headSha = "new";
    return response();
  });
  expect((await service().explain(input())).state).toBe("unavailable");
  const row = (
    await pool.query("SELECT status,result FROM merge_risk_explanations")
  ).rows[0];
  expect(row.status).toBe("stale");
  expect(row.result.text).toBeUndefined();
  expect(row.result.estimatedUsd).toBeGreaterThan(0);
});
it("explicit failure retry consumes another reservation and retains attempt accounting", async () => {
  transport.mockImplementationOnce(async () =>
    Response.json({ error: "private" }, { status: 500 })
  );
  expect((await service().explain(input())).state).toBe("failed");
  expect((await service().explain(input())).state).toBe("ready");
  const row = (await pool.query("SELECT result FROM merge_risk_explanations"))
    .rows[0];
  expect(row.result.attempts).toHaveLength(2);
  expect(
    (await pool.query("SELECT calls FROM merge_risk_decision_daily")).rows[0]
      .calls
  ).toBe(2);
});
it.each(["routine", "human_review", "abstain"])(
  "grounds %s follow-ups in the completed assessment",
  async (verdict) => {
    await pool.query(
      "UPDATE merge_risk_decision_records SET result=result || $2::jsonb WHERE id=$1",
      [id, JSON.stringify({ verdict })]
    );
    await service().explain(input());
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input[0].content[0].text).assessment.verdict).toBe(
      verdict
    );
    expect(body.instructions).toContain("product judgment");
    expect(body.instructions).toContain("abstain");
  }
);
it("withholds identities and summaries while retaining bounded technical mitigations", () => {
  const safe = followupEvidence({
    reviews: [
      {
        reviewer: "private name",
        summary: "private summary",
        findings: [
          {
            settlement_by: "reviewer",
            title: "Recheck settings after eligibility",
            note: "Verified settings changes prevent provider dispatch",
            path: "auth/session.ts",
            status: "fixed",
          },
        ],
      },
    ],
    briefing: "private launch",
  });
  expect(JSON.stringify(safe)).not.toContain("private summary");
  expect(JSON.stringify(safe)).toContain("auth/session.ts");
  expect(JSON.stringify(safe)).toContain("Recheck settings after eligibility");
  expect(JSON.stringify(safe)).toContain(
    "Verified settings changes prevent provider dispatch"
  );
  expect(JSON.stringify(safe)).not.toContain("private name");
  expect(JSON.stringify(safe)).not.toContain("private launch");
  expect(followupEvidence(null)).toEqual({});
});
it("prices Responses input/cache/output honestly; malformed usage stays unknown", () => {
  expect(
    explanationUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 50,
      total_tokens: 150,
    }).estimatedUsd
  ).toBeCloseTo(0.0000332);
  expect(explanationUsage({ input_tokens: 100 }).estimatedUsd).toBeNull();
});
it.each(["incomplete", "refusal", "oversized", "secret"])(
  "rejects %s provider output without retaining arbitrary errors",
  async (kind) => {
    const reply =
      kind === "incomplete"
        ? { status: "incomplete", output: [] }
        : kind === "refusal"
          ? {
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "refusal", refusal: "private" }],
                },
              ],
            }
          : null;
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply
          ? Response.json(reply)
          : response(kind === "secret" ? "synthetic-key" : "x".repeat(2000))
      );
    const result = await requestExplanation("synthetic-key", {}, mock);
    expect(result.status).toBe("error");
    expect(result.text).toBeUndefined();
  }
);
it("settings invalidation during a call suppresses the result", async () => {
  transport.mockImplementation(async () => {
    await settings.save({ mergeRiskMode: "off" });
    return response();
  });
  expect((await service().explain(input())).state).toBe("unavailable");
  expect(
    (await pool.query("SELECT result FROM merge_risk_explanations")).rows[0]
      .result.text
  ).toBeUndefined();
});
it("CI-only transitions reuse the same follow-up", async () => {
  const svc = service();
  await svc.explain(input());
  pr.ci = {
    ...pr.ci,
    availability: "available",
    summary: {
      status: "passing",
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
    },
  } as AgentPullRequest["ci"];
  expect((await svc.explain(input())).state).toBe("ready");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("redacts known credential forms from retained evidence", () => {
  const text = JSON.stringify(
    retainedEvidence(
      {
        description: "sk-1234567890abcdef Authorization: Bearer private-value",
        nested: ["synthetic-key"],
      },
      "synthetic-key"
    )
  );
  expect(text).not.toContain("1234567890abcdef");
  expect(text).not.toContain("private-value");
  expect(text).not.toContain("synthetic-key");
});

it.each(["off", "removed", "replaced"])(
  "revocation during pre-dispatch DB awaits prevents spend (%s)",
  async (mode) => {
    settings = new RoutingSettings(pool, {}, async () => Response.json({}));
    const original = pool.query.bind(pool) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let reads = 0;
    const spy = vi.spyOn(pool, "query").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await original(...args);
      if (
        typeof args[0] === "string" &&
        args[0].includes("SELECT s.*") &&
        ++reads === 2
      ) {
        await settings.save(
          mode === "off"
            ? { mergeRiskMode: "off" }
            : mode === "removed"
              ? { removeKey: true }
              : { apiKey: "replacement-key" }
        );
      }
      return result;
    }) as typeof pool.query);
    try {
      expect((await service().explain(input())).state).toBe("unavailable");
      expect(transport).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }
);

it.each(
  [false, true].flatMap((legacy) =>
    ["reviewer", "person", "author", "unknown"].map((role) => ({
      legacy,
      role,
    }))
  )
)(
  "carries attributed findings and redacts credentials ($role, legacy=$legacy)",
  async ({ legacy, role }) => {
    const { BlockStore } = await import("../src/chat/store.js");
    const { MergeRiskAssessor } =
      await import("../src/agents/merge-risk/assessor.js");
    const blocks = new BlockStore(pool);
    await pool.query("DELETE FROM merge_risk_decision_records");
    await pool.query(
      "INSERT INTO agents(id,name,cwd,status,persona) VALUES('full-context-reviewer','Reviewer','/tmp','stopped','auth-trust-owner') ON CONFLICT DO NOTHING"
    );
    const review = await blocks.insert({
      streamId: "full-context-reviewer",
      toAgentId: "explain-owner",
      author: { kind: "agent", agentId: "full-context-reviewer" },
      kind: "review",
      data: { summary: "Private reviewer summary" },
    });
    const technicalNote =
      "Verified key replacement during DB waits prevents dispatch";
    const credentialNote =
      technicalNote +
      "\n-----BEGIN PRIVATE KEY-----\n" +
      "SYNTHETICKEYMATERIAL".repeat(30) +
      "\n-----END PRIVATE KEY-----";
    const finding = await blocks.insert({
      streamId: "full-context-reviewer",
      toAgentId: "explain-owner",
      author: { kind: "agent", agentId: "full-context-reviewer" },
      kind: "finding",
      replyTo: review.id,
      data: {
        title: "Prevent stale provider dispatch",
        severity: "major",
        path: "apps/server/src/agents/merge-risk/explanations.ts",
      },
      state: {
        status: "resolved",
        resolution: "fixed",
        note: credentialNote,
        ...(role === "unknown"
          ? {}
          : {
              by:
                role === "person"
                  ? { kind: "user", userId: "person" }
                  : {
                      kind: "agent",
                      agentId:
                        role === "author"
                          ? "explain-owner"
                          : "full-context-reviewer",
                    },
            }),
      },
    });
    await blocks.update(review.id, { state: { blocks: [finding.id] } });
    const scoring = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        answers: [
          { type: "score", name: "change_risk", score: 2.1, probabilities: [] },
          { type: "predicate", name: "review_adequate", probability: 0.94 },
          {
            type: "predicate",
            name: "description_matches_diff",
            probability: 0.93,
          },
          {
            type: "predicate",
            name: "new_user_facing_surface",
            probability: 0.1,
          },
          {
            type: "choice",
            name: "needs_human",
            choice: "human_review",
            confidence: 0.9,
            probabilities: [{ value: "human_review", probability: 0.9 }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
      })
    );
    const assessor = new MergeRiskAssessor({
      pool,
      settings,
      agentRoot: async () => null,
      transport: scoring,
      readDetails: async () => ({
        number: 1,
        title: "Explain assessment",
        body: "Add explicit on-demand explanations inside the existing PR popover",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
        additions: 100,
        deletions: 10,
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: "abc",
        files: [
          {
            path: "apps/server/src/agents/merge-risk/explanations.ts",
            additions: 90,
            deletions: 5,
          },
          {
            path: "apps/web/src/components/app/agent-pull-requests.tsx",
            additions: 10,
            deletions: 5,
          },
        ],
        statusCheckRollup: [],
      }),
    });
    pr.mergeRisk = await assessor.assess(pr.url, pr, ["explain-owner"]);
    expect(pr.mergeRisk?.status).toBe("ok");
    id = pr.mergeRisk!.assessmentId!;
    const saved = (
      await pool.query(
        "SELECT evidence FROM merge_risk_evidence_snapshots WHERE assessment_id=$1",
        [id]
      )
    ).rows[0].evidence;
    expect(JSON.stringify(saved)).not.toContain("SYNTHETICKEYMATERIAL");
    if (legacy) {
      saved.reviews[0].findings[0].note = credentialNote.slice(0, 300);
      await pool.query(
        "UPDATE merge_risk_evidence_snapshots SET evidence=$2 WHERE assessment_id=$1",
        [id, JSON.stringify(saved)]
      );
    }
    expect((await service().explain(input())).state).toBe("ready");
    const wire = JSON.parse(String(transport.mock.calls[0][1]?.body));
    const actual = JSON.parse(wire.input[0].content[0].text);
    expect(actual.evidence.reviews[0].findings[0]).toMatchObject({
      title: "Prevent stale provider dispatch",
      severity: "major",
      status: "fixed",
    });
    expect(actual.evidence.reviews[0].findings[0].settlement_by).toBe(role);
    if (role === "reviewer" || role === "person")
      expect(actual.evidence.reviews[0].findings[0].note).toContain(
        technicalNote
      );
    else
      expect(actual.evidence.reviews[0].findings[0].note).toBe(
        "[unverified resolution note withheld]"
      );
    const scoringPayload = JSON.parse(String(scoring.mock.calls[0][1]?.body))
      .input[0].content[1].data;
    expect(scoringPayload.reviews[0].findings[0]).not.toHaveProperty(
      "settlement_by"
    );
    expect(scoringPayload.reviews[0].findings[0]).not.toHaveProperty(
      "settlementBy"
    );
    expect(JSON.stringify(actual)).not.toContain("SYNTHETICKEYMATERIAL");
    expect(JSON.stringify(actual)).not.toContain("BEGIN PRIVATE KEY");
    expect(actual.evidence.reviews[0].summary).toBe("[summary withheld]");
    expect(actual.evidence.reviews[0].reviewer).toBe("reviewer");
    expect(actual.assessment.reviewAdequate).toBe(0.94);
    expect(
      (await pool.query("SELECT calls FROM merge_risk_decision_daily")).rows[0]
        .calls
    ).toBe(2);
    await service().explain(input());
    expect(transport).toHaveBeenCalledTimes(1);
    await blocks.update(finding.id, {
      state: {
        status: "resolved",
        resolution: "fixed",
        note: credentialNote,
        by: {
          kind: "agent",
          agentId:
            role === "author" ? "full-context-reviewer" : "explain-owner",
        },
      },
    });
    expect((await service().explain(input())).state).toBe("unavailable");
    expect(transport).toHaveBeenCalledTimes(1);
    await pool.query("DELETE FROM blocks WHERE to_agent_id='explain-owner'");
  }
);
