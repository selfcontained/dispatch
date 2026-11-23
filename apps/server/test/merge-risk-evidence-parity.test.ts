/*
 * Merge-risk evidence through the agent's runner. Local grades, records and
 * GitHub calls are pinned to main's: the golden values below were captured
 * from main's local path (`gh pr view` details, unscoped records, compare
 * from the PR's current base) on recorded fixture evidence. A runner given
 * the same evidence sends the same grading input. Fixture `gh` only.
 */
import { createHash } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import {
  BASE,
  COMPARE,
  HEAD,
  PR_VIEW,
  URL_,
} from "./merge-risk-local-fixture.js";

const gh = vi.hoisted(() => ({
  calls: [] as { args: string[]; options: unknown }[],
  run: null as null | ((args: string[], options: unknown) => unknown),
}));
vi.mock("../src/shared/lib/run-command.js", async (original) => {
  const actual =
    await original<typeof import("../src/shared/lib/run-command.js")>();
  return {
    ...actual,
    runCommand: (
      bin: string,
      args: string[],
      options: Parameters<typeof actual.runCommand>[2]
    ) =>
      bin === "gh"
        ? (gh.run as NonNullable<typeof gh.run>)(args, options)
        : actual.runCommand(bin, args, options),
  };
});

import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";
import {
  explanationReply,
  fixtureGh,
  fixturePr,
  providerAnswers,
} from "./merge-risk-local-fixture.js";
import { MergeRiskAssessor } from "../src/agents/merge-risk/assessor.js";
import { RiskExplanations } from "../src/agents/merge-risk/explanations.js";
import {
  createMergeRiskGitHubSource,
  mergeRiskScope,
} from "../src/agents/merge-risk/github-source.js";
import { reviewFingerprint } from "../src/agents/merge-risk/sources.js";
import { projectPullRequest } from "../src/agents/pull-request-reader.js";
import { githubWorkload } from "../src/agents/checkout-worker.js";
import { githubHandlers } from "../../../packages/runner/src/core/github.js";
import { createLocalCheckoutRunner } from "../src/runners/local.js";
import { RoutingSettings } from "../src/chat/routing-settings.js";

/** Captured from main's local path; see the file comment. */
const GOLDEN = {
  gradingInput:
    "5a1e06d5aa8aa5a291ff44f68d5bb2f17eea9efcabace390ec229a80c1ac5124",
  snapshot: "cb80f1ead1da1e40f927bd05321d57360d36741e9df26dba7b49bafd2d713c7b",
  explanationInput:
    "b3ba008017ef466aa14472ff60dcce8fe66efea88225a2f0b97dc377021f2ff0",
  summary: {
    verdict: "routine",
    changeRisk: 0.6,
    changeRiskLabel: "moderate",
    reviewAdequate: 0.7,
    descriptionMatches: 0.8,
    newSurface: 0.2,
    routineProbability: 0.9,
    humanReviewProbability: 0.1,
    confidence: 0.95,
    status: "ok",
    promptVersion: "merge-risk-v2",
    headSha: HEAD,
  },
  record: {
    url: URL_,
    head_sha: HEAD,
    review_fingerprint: "4f53cda18c2baa0c",
    status: "ok",
    prompt_version: "merge-risk-v2",
    evidence_scope: "",
    base_sha: null,
  },
  result: {
    model: "gpt-6-luna",
    usage: { input_tokens: 100, total_tokens: 100, output_tokens: 0 },
    verdict: "routine",
    changeRisk: 0.6,
    confidence: 0.95,
    newSurface: 0.2,
    reviewAdequate: 0.7,
    changeRiskLabel: "moderate",
    descriptionMatches: 0.8,
    routineProbability: 0.9,
    humanReviewProbability: 0.1,
  },
  prView: {
    args: [
      "pr",
      "view",
      "9",
      "--repo",
      "acme/widgets",
      "--json",
      "number,title,body,state,isDraft,mergedAt,additions,deletions,baseRefName,headRefName,headRefOid,files,statusCheckRollup",
    ],
    options: { timeoutMs: 30000, allowedExitCodes: [0, 1] },
  },
  pullBase: {
    args: ["api", "repos/acme/widgets/pulls/9", "--jq", ".base.sha"],
    options: { timeoutMs: 15000, allowedExitCodes: [0, 1] },
  },
  compare: {
    args: [
      "api",
      `repos/acme/widgets/compare/${BASE}...${HEAD}`,
      "--jq",
      "[.files[] | {path: .filename, additions, deletions, patch}]",
    ],
    options: { timeoutMs: 20000, allowedExitCodes: [0, 1] },
  },
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const explanationSha = (body: string) =>
  sha(body.replace(/"assessedAt[^,]*,/, ""));
const description = {
  runnerId: "local",
  displayName: "Local",
  build: { version: "" },
  protocol: 1,
  engines: [],
  capabilities: {},
} as never;
const ready = (call: (op: string, input: never) => Promise<unknown>) =>
  ({
    connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    call,
  }) as unknown as Runner;

/** The local runner as the app builds it, with and without its child. */
const locals = {
  "in process": () => createLocalCheckoutRunner(undefined, description),
  "in the child": () => {
    const served = githubHandlers({
      workload: {} as never,
      github: githubWorkload,
    }) as Record<string, (input: never, context: never) => Promise<unknown>>;
    return createLocalCheckoutRunner(
      undefined,
      description,
      ready((op, input) => served[op]!(input, {} as never))
    );
  },
  "after the child dies mid-call": () =>
    createLocalCheckoutRunner(
      undefined,
      description,
      ready(async (op) => {
        throw new RunnerCallError({
          code: "unknown_outcome",
          message: `The ${op} reply did not arrive`,
        });
      })
    ),
};

let pool: Pool;
let settings: RoutingSettings;
const transport = vi.fn<typeof fetch>();
const explanationTransport = vi.fn<typeof fetch>();

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query(
    "TRUNCATE merge_risk_decision_records,merge_risk_decision_daily CASCADE"
  );
  await pool.query("DELETE FROM settings");
  await pool.query(
    "INSERT INTO settings(key,value,updated_at) VALUES('routing_api_key','k',now()),('merge_risk_mode','active',now())"
  );
  settings = new RoutingSettings(pool, {});
  const fixture = fixtureGh();
  gh.calls = fixture.calls;
  gh.run = (args, options) =>
    fixture.run("gh", args, options as Parameters<typeof fixture.run>[2]);
  transport.mockReset();
  transport.mockImplementation(async () => providerAnswers());
  explanationTransport.mockReset();
  explanationTransport.mockImplementation(async () => explanationReply());
});

async function records() {
  return (
    await pool.query(
      "SELECT url,head_sha,review_fingerprint,status,prompt_version,result,evidence_scope,base_sha FROM merge_risk_decision_records ORDER BY id"
    )
  ).rows.map(({ result, ...row }) => {
    const { latencyMs: _latency, ...rest } = result;
    return { ...row, result: rest };
  });
}

describe("local merge-risk evidence matches main", () => {
  it.each(Object.keys(locals) as (keyof typeof locals)[])(
    "grades, records and explains recorded evidence as main did (%s)",
    async (mode) => {
      const runner = locals[mode]();
      const github = createMergeRiskGitHubSource(() => runner);
      const assessor = new MergeRiskAssessor({
        pool,
        settings,
        github,
        agentRoot: async () => null,
        transport,
      });
      const assessed = await assessor.assess(URL_, fixturePr(), []);
      expect(assessed).toMatchObject(GOLDEN.summary);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(sha(String(transport.mock.calls[0]![1]!.body))).toBe(
        GOLDEN.gradingInput
      );
      expect(await records()).toEqual([
        { ...GOLDEN.record, result: GOLDEN.result },
      ]);
      const snapshots = await pool.query(
        "SELECT owner_ids,review_digest,evidence,owner_projects FROM merge_risk_evidence_snapshots"
      );
      expect(sha(JSON.stringify(snapshots.rows))).toBe(GOLDEN.snapshot);
      // main's GitHub calls: one details read for an evaluating assessment.
      expect(gh.calls).toEqual([GOLDEN.prView]);

      // None for one that reuses its record.
      gh.calls.length = 0;
      expect((await assessor.assess(URL_, fixturePr(), []))?.assessmentId).toBe(
        assessed?.assessmentId
      );
      expect(gh.calls).toEqual([]);
      expect(transport).toHaveBeenCalledTimes(1);

      // The explanation compares from the PR's current base, as main did.
      const explanations = new RiskExplanations({
        pool,
        settings,
        github,
        transport: explanationTransport,
      });
      expect(
        await explanations.explain({
          assessmentId: assessed!.assessmentId!,
          url: URL_,
          runnerId: null,
        })
      ).toEqual({ state: "ready", text: "Because migrations." });
      expect(gh.calls).toEqual([GOLDEN.pullBase, GOLDEN.compare]);
      const explained = String(explanationTransport.mock.calls[0]![1]!.body);
      expect(explanationSha(explained)).toBe(GOLDEN.explanationInput);
      expect(explained).toContain("db/migrations/0042_add_users.sql");
    }
  );

  it("reuses a record saved by main without re-grading or reading GitHub", async () => {
    const saved = (
      await pool.query(
        "INSERT INTO merge_risk_decision_records(url,head_sha,review_fingerprint,status,prompt_version,result) VALUES($1,$2,$3,'ok','merge-risk-v2',$4) RETURNING id",
        [
          URL_,
          HEAD,
          reviewFingerprint([]),
          JSON.stringify({ verdict: "human_review", changeRisk: 3 }),
        ]
      )
    ).rows[0].id;
    const assessor = new MergeRiskAssessor({
      pool,
      settings,
      github: createMergeRiskGitHubSource(() => locals["in process"]()),
      agentRoot: async () => null,
      transport,
    });
    expect(await assessor.assess(URL_, fixturePr(), [])).toMatchObject({
      assessmentId: saved,
      verdict: "human_review",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(gh.calls).toEqual([]);
  });
});

describe("runner merge-risk evidence", () => {
  const alpha = "a".repeat(64);
  const beta = "b".repeat(64);
  /** An enrolled runner's answers for the same recorded pull request. */
  function enrolled(credentialContext: string) {
    const call = vi.fn(async (op: string, input: Record<string, unknown>) => {
      if (op === "github.pr.details")
        return {
          credentialContext,
          number: PR_VIEW.number,
          title: PR_VIEW.title,
          body: PR_VIEW.body,
          baseRefName: PR_VIEW.baseRefName,
          headRefName: PR_VIEW.headRefName,
          baseRefOid: BASE,
          headRefOid: PR_VIEW.headRefOid,
          additions: PR_VIEW.additions,
          deletions: PR_VIEW.deletions,
          files: PR_VIEW.files,
        };
      if (op === "github.pr.diff")
        return input.base === BASE && input.context === credentialContext
          ? { files: COMPARE }
          : null;
      throw new Error(op);
    });
    return { call } as unknown as Pick<Runner, "call"> & {
      call: typeof call;
    };
  }
  const observed = (credentialContext: string) =>
    projectPullRequest(URL_, "Harden login", {
      title: "Harden login",
      state: "OPEN",
      draft: false,
      head: HEAD,
      rollup: PR_VIEW.statusCheckRollup,
      credentialContext,
    });

  it("grades the same evidence as local, keyed to its credential", async () => {
    const runners = new Map([
      ["r1", enrolled(alpha)],
      ["r2", enrolled(beta)],
    ]);
    const github = createMergeRiskGitHubSource((id) => runners.get(id!)!);
    const assessor = new MergeRiskAssessor({
      pool,
      settings,
      github,
      agentRoot: async () => null,
      transport,
    });
    // A record saved locally (main's empty scope) is never a runner's.
    await pool.query(
      "INSERT INTO merge_risk_decision_records(url,head_sha,review_fingerprint,status,prompt_version,result) VALUES($1,$2,$3,'ok','merge-risk-v2','{}')",
      [URL_, HEAD, reviewFingerprint([])]
    );
    const first = await assessor.assess(
      URL_,
      observed(alpha),
      [],
      undefined,
      "r1"
    );
    expect(first).toMatchObject(GOLDEN.summary);
    expect(sha(String(transport.mock.calls[0]![1]!.body))).toBe(
      GOLDEN.gradingInput
    );
    expect(runners.get("r1")!.call).toHaveBeenCalledTimes(1);
    const scoped = (await records()).at(-1);
    expect(scoped).toMatchObject({
      evidence_scope: mergeRiskScope("r1", alpha),
      base_sha: BASE,
    });

    // Reused without another read; another credential has its own record.
    expect(
      (await assessor.assess(URL_, observed(alpha), [], undefined, "r1"))
        ?.assessmentId
    ).toBe(first?.assessmentId);
    expect(runners.get("r1")!.call).toHaveBeenCalledTimes(1);
    const second = await assessor.assess(
      URL_,
      observed(beta),
      [],
      undefined,
      "r2"
    );
    expect(second?.assessmentId).not.toBe(first?.assessmentId);
    expect(transport).toHaveBeenCalledTimes(2);

    // The explanation sends what local sends for the same evidence.
    const explanations = new RiskExplanations({
      pool,
      settings,
      github,
      transport: explanationTransport,
    });
    expect(
      await explanations.explain({
        assessmentId: first!.assessmentId!,
        url: URL_,
        runnerId: "r1",
      })
    ).toEqual({ state: "ready", text: "Because migrations." });
    expect(
      explanationSha(String(explanationTransport.mock.calls[0]![1]!.body))
    ).toBe(GOLDEN.explanationInput);
    expect(
      await explanations.explain({
        assessmentId: first!.assessmentId!,
        url: URL_,
        runnerId: "r2",
      })
    ).toEqual({ state: "unavailable", reason: "not_found" });
    expect(gh.calls).toEqual([]);
  });

  it("asks again after a runner that could not answer, without recording a failure", async () => {
    const runner = enrolled(alpha);
    const answer = runner.call.getMockImplementation()!;
    runner.call.mockImplementationOnce(async () => {
      throw new RunnerCallError({ code: "unavailable", message: "offline" });
    });
    const assessor = new MergeRiskAssessor({
      pool,
      settings,
      github: createMergeRiskGitHubSource(() => runner),
      agentRoot: async () => null,
      transport,
    });
    expect(
      await assessor.assess(URL_, observed(alpha), [], undefined, "r1")
    ).toMatchObject({ displayState: "unavailable" });
    expect(transport).not.toHaveBeenCalled();
    runner.call.mockImplementation(answer);
    expect(
      await assessor.assess(URL_, observed(alpha), [], undefined, "r1")
    ).toMatchObject(GOLDEN.summary);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
