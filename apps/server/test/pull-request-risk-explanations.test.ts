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
const input = () => ({ assessmentId: id });
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
const service = () =>
  new RiskExplanations({
    pool,
    settings,
    transport,
  });
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES('explain-owner','Owner','/tmp','running'),('other-owner','Other','/tmp','running')"
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
  const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(body).toMatchObject({
    store: false,
    background: false,
    tools: [],
    max_output_tokens: 512,
  });
  expect(JSON.stringify(body)).not.toContain("private launch");
});
const wireInput = (call = 0) =>
  JSON.parse(
    JSON.parse(String(transport.mock.calls[call][1]?.body)).input[0].content[0]
      .text
  );
it("disabled settings refuse before any lookup and say so", async () => {
  await pool.query(
    "UPDATE settings SET value='off' WHERE key='merge_risk_mode'"
  );
  settings = new RoutingSettings(pool, {});
  expect(await service().explain(input())).toEqual({
    state: "unavailable",
    reason: "disabled",
  });
  expect(transport).not.toHaveBeenCalled();
});
it.each(["unknown id", "malformed id", "not a completed assessment"])(
  "refuses %s honestly without spending",
  async (reason) => {
    let request = input();
    if (reason === "unknown id") request = { ...request, assessmentId: "999" };
    if (reason === "malformed id")
      request = { ...request, assessmentId: "99999999999999999999" };
    if (reason === "not a completed assessment")
      await pool.query(
        "UPDATE merge_risk_decision_records SET status='error' WHERE id=$1",
        [id]
      );
    expect(await service().explain(request)).toEqual({
      state: "unavailable",
      reason: "not_found",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT 1 FROM merge_risk_explanations")).rowCount
    ).toBe(0);
  }
);
it.each([
  "head moved on",
  "merged",
  "closed",
  "reviews changed",
  "open findings",
  "inventory evicted",
])(
  "explains the saved assessment after the PR %s, as that assessment",
  async (change) => {
    // Nothing about the live PR is consulted; the service has no inventory.
    if (change === "reviews changed" || change === "open findings")
      await pool.query(
        "UPDATE merge_risk_evidence_snapshots SET review_digest='changed'"
      );
    if (change === "open findings") {
      const { BlockStore } = await import("../src/chat/store.js");
      const blocks = new BlockStore(pool);
      const review = await blocks.insert({
        streamId: "other-owner",
        toAgentId: "explain-owner",
        author: { kind: "agent", agentId: "other-owner" },
        kind: "review",
        data: { summary: "late review" },
      });
      await blocks.insert({
        streamId: "other-owner",
        toAgentId: "explain-owner",
        author: { kind: "agent", agentId: "other-owner" },
        kind: "finding",
        replyTo: review.id,
        data: { title: "Open", severity: "major" },
        state: { status: "open" },
      });
    }
    const reply = await service().explain(input());
    expect(reply).toEqual({ state: "ready", text: expect.any(String) });
    expect(transport).toHaveBeenCalledTimes(1);
    const wire = wireInput();
    expect(wire.context).toMatchObject({
      assessedCommit: "abc",
      evidenceRetained: true,
    });
    expect(Date.parse(wire.context.assessedAt)).not.toBeNaN();
    expect(wire.evidence.files).toEqual([{ path: "auth/session.ts" }]);
    expect(JSON.stringify(wire)).not.toContain("late review");
    const instructions = JSON.parse(
      String(transport.mock.calls[0][1]?.body)
    ).instructions;
    expect(instructions).toContain("never say it still applies");
    await pool.query("DELETE FROM blocks WHERE to_agent_id='explain-owner'");
  }
);
it("legacy records without saved detail still explain from recorded scores, marked limited", async () => {
  await pool.query("DELETE FROM merge_risk_evidence_snapshots");
  const svc = service();
  expect(await svc.explain(input())).toEqual({
    state: "ready",
    text: expect.any(String),
    limitedEvidence: true,
  });
  const wire = wireInput();
  expect(wire.context.evidenceRetained).toBe(false);
  expect(wire.evidence).toBeNull();
  expect(wire.assessment).toMatchObject({
    verdict: "human_review",
    changeRiskLabel: "high",
  });
  expect(
    JSON.parse(String(transport.mock.calls[0][1]?.body)).instructions
  ).toContain("start directly with the recorded assessment signals");
  // Reuse keeps the limited marker without another request.
  expect(await svc.explain(input())).toMatchObject({ limitedEvidence: true });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("enforces no daily call limit: a full legacy counter does not block a click", async () => {
  vi.stubEnv("DISPATCH_MERGE_RISK_DAILY_CAP", "0");
  try {
    await pool.query(
      "INSERT INTO merge_risk_decision_daily(day,calls) VALUES((now() AT TIME ZONE 'UTC')::date,25)"
    );
    expect((await service().explain(input())).state).toBe("ready");
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
  }
});
it.each([
  [401, "provider_rejected"],
  [403, "provider_rejected"],
  [429, "provider_rate_limited"],
  [500, "provider_error"],
])(
  "reports provider status %s as %s, never as a Dispatch limit",
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
});
it("settings saved while reserving abort before the request and record why", async () => {
  const real = settings.configuration.bind(settings);
  let reads = 0;
  // Read 3 is the first one after the reservation commits.
  vi.spyOn(settings, "configuration").mockImplementation(async () =>
    ++reads >= 3 ? { ...(await real()) } : real()
  );
  expect(await service().explain(input())).toEqual({
    state: "unavailable",
    reason: "config_changed",
  });
  expect(transport).not.toHaveBeenCalled();
  const row = (
    await pool.query("SELECT status,result FROM merge_risk_explanations")
  ).rows[0];
  expect(row).toMatchObject({
    status: "stale",
    result: { reason: "config_changed" },
  });
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
it("PR activity during the request does not discard the explanation", async () => {
  transport.mockImplementation(async () => {
    // A new push and a new review land while the provider is answering.
    await pool.query(
      "UPDATE merge_risk_evidence_snapshots SET review_digest='changed'"
    );
    await pool.query(
      "INSERT INTO merge_risk_decision_records(url,head_sha,review_fingerprint,status,prompt_version) VALUES($1,'newer','r','ok','v')",
      [pr.url]
    );
    return response();
  });
  expect((await service().explain(input())).state).toBe("ready");
  const row = (
    await pool.query("SELECT status,result FROM merge_risk_explanations")
  ).rows[0];
  expect(row.status).toBe("ok");
  expect(row.result.estimatedUsd).toBeGreaterThan(0);
});
it("explicit failure retry makes one more request and retains attempt accounting", async () => {
  transport.mockImplementationOnce(async () =>
    Response.json({ error: "private" }, { status: 500 })
  );
  expect((await service().explain(input())).state).toBe("failed");
  expect((await service().explain(input())).state).toBe("ready");
  const row = (await pool.query("SELECT result FROM merge_risk_explanations"))
    .rows[0];
  expect(row.result.attempts).toHaveLength(2);
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
  expect(await service().explain(input())).toEqual({
    state: "unavailable",
    reason: "config_changed",
  });
  const row = (
    await pool.query("SELECT status,result FROM merge_risk_explanations")
  ).rows[0];
  expect(row.status).toBe("stale");
  expect(row.result).toMatchObject({ reason: "config_changed" });
  expect(row.result.text).toBeUndefined();
  expect(row.result.estimatedUsd).toBeGreaterThan(0);
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
        args[0].includes("FROM merge_risk_decision_records r") &&
        ++reads === 1
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
      expect(await service().explain(input())).toEqual({
        state: "unavailable",
        reason: "config_changed",
      });
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
    // Later settlement changes do not invalidate the saved explanation.
    expect((await service().explain(input())).state).toBe("ready");
    expect(transport).toHaveBeenCalledTimes(1);
    await pool.query("DELETE FROM blocks WHERE to_agent_id='explain-owner'");
  }
);
