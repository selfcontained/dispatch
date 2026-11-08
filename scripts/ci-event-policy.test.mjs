import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const require = createRequire(
  new URL("../apps/server/package.json", import.meta.url)
);
const { parse } = require("yaml");
const load = (name) =>
  parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8"
    )
  );
const code = load("ci");
const metadata = load("pr-metadata");
const job = code.jobs.ci;
test("every subscribed code workflow run retains the actual required ci job", () => {
  assert.equal(job.name, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job["runs-on"], "self-hosted");
  assert.deepEqual(code.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
  ]);
  assert.deepEqual(code.on.pull_request.branches, ["main", "acp-runtime"]);
  assert.deepEqual(metadata.on.pull_request, {
    branches: code.on.pull_request.branches,
    types: ["opened", "synchronize", "reopened", "edited"],
  });
  assert.deepEqual(Object.keys(code.on), ["pull_request"]);
  assert.notEqual(code.concurrency.group, metadata.concurrency.group);
  assert.equal(
    job.steps.find((step) => step.name === "Require explicit PR owner coverage")
      .if,
    undefined
  );
  assert.equal(
    job.steps.find((step) => step.name === "CI checks").run,
    "node scripts/run-owned.mjs pnpm run ci"
  );
  assert.equal(
    job.steps.find((step) => step.name === "Build Bun binaries").run,
    "node scripts/run-owned.mjs pnpm run build:bun"
  );
  assert.ok(!job.steps.some((step) => step.name?.includes("session links")));
});
test("metadata remains independently required with no PR code execution", () => {
  assert.equal(metadata.jobs.metadata.name, "PR metadata");
  assert.equal(metadata.jobs.metadata.if, undefined);
  assert.equal(metadata.jobs.metadata.steps.length, 1);
  assert.equal(metadata.jobs.metadata.steps[0].if, undefined);
  assert.deepEqual(metadata.permissions, {});
});
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function checkCurrentMetadata({
  body = "corrected $(untrusted)",
  head = "a".repeat(40),
  target = "main",
  state = "open",
  race = false,
  apiFailure = false,
  cutoff = null,
  proofChanges = {},
  runChanges = {},
  artifactChanges = {},
  jobChanges = {},
  rawArchive,
  completeAfterWait = false,
  expireWait = false,
} = {}) {
  let waits = 0;
  let clock = 0;
  const failures = [];
  const logs = [];
  let reads = 0;
  const expected = {
    head: { sha: "a".repeat(40), repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
    body: "claude.ai/code/session/stale-event",
  };
  const proof = {
    version: 1,
    number: 123,
    head: expected.head.sha,
    base: "b".repeat(40),
    merge: "c".repeat(40),
    target: "main",
    repository: "owner/repo",
    headRepository: "owner/repo",
    run: "42",
    attempt: "1",
    eventUpdatedAt: "2026-11-07T00:02:00Z",
    ...proofChanges,
  };
  const archive =
    rawArchive ??
    execFileSync(
      "python3",
      [
        "-c",
        "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('ci-context.json',sys.stdin.read()); z.close(); sys.stdout.buffer.write(b.getvalue())",
      ],
      { input: JSON.stringify(proof) }
    );
  const run = {
    id: 42,
    run_attempt: 1,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: expected.head.sha,
    status: "completed",
    conclusion: "success",
    pull_requests: [{ number: 123 }],
    ...runChanges,
  };
  const artifact = {
    id: 99,
    name: "ci-context-1",
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: { id: 42, head_sha: expected.head.sha },
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    created_at: "2026-11-07T00:03:00Z",
    ...artifactChanges,
  };
  const github = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          timelineItems: { nodes: cutoff ? [{ createdAt: cutoff }] : [] },
        },
      },
    }),
    rest: {
      actions: {
        listWorkflowRuns: async () => ({
          data: {
            workflow_runs:
              completeAfterWait && !waits
                ? [{ ...run, status: "in_progress", conclusion: null }]
                : [run],
          },
        }),
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: [artifact] },
        }),
        downloadArtifact: async () => ({ data: archive }),
        listJobsForWorkflowRun: async () => ({
          data: {
            jobs: [
              {
                name: "ci",
                head_sha: expected.head.sha,
                status: "completed",
                conclusion: "success",
                ...jobChanges,
              },
            ],
          },
        }),
      },
      pulls: {
        get: async () => {
          if (apiFailure) throw new Error("API unavailable");
          reads++;
          return {
            data: {
              ...expected,
              state,
              head: { ...expected.head, sha: head },
              base: { ...expected.base, ref: target },
              title: "PR",
              body: race && reads === 2 ? "changed" : body,
            },
          };
        },
      },
    },
  };
  await new AsyncFunction(
    "github",
    "context",
    "core",
    "require",
    "setTimeout",
    "Date",
    metadata.jobs.metadata.steps[0].with.script
  )(
    github,
    {
      repo: { owner: "owner", repo: "repo" },
      payload: { number: 123, pull_request: expected },
    },
    {
      setFailed: (message) => failures.push(message),
      info: (message) => logs.push(message),
    },
    require,
    (resolve) => {
      waits++;
      if (completeAfterWait) return resolve();
      if (expireWait) {
        clock += 46 * 60 * 1000;
        return resolve();
      }
      throw new Error("WAITING_FOR_EVIDENCE");
    },
    { parse: Date.parse, now: () => clock }
  );
  return { failures, logs, reads, waits };
}
test("metadata uses only PR and Actions read permissions and never publishes custom checks", () => {
  assert.deepEqual(metadata.jobs.metadata.permissions, {
    "pull-requests": "read",
    actions: "read",
  });
  assert.equal(
    metadata.jobs.metadata.steps[0].uses,
    "actions/github-script@v8"
  );
});
test("retry reads corrected current metadata despite the original bad event", async () => {
  const result = await checkCurrentMetadata();
  assert.equal(result.failures.length, 0);
  assert.equal(result.reads, 4);
  assert.ok(!result.logs.join("").includes("untrusted"));
});
test("current bad metadata fails without logging link contents", async () => {
  const result = await checkCurrentMetadata({
    body: "CLAUDE.ai/code/session/private-id",
  });
  assert.equal(result.failures.length, 1);
  assert.match(
    result.failures[0],
    /rerun this specific failed PR metadata run/
  );
  assert.ok(
    !result.failures.concat(result.logs).join("").includes("private-id")
  );
});
for (const options of [
  { head: "changed" },
  { target: "changed" },
  { state: "closed" },
  { race: true },
  { apiFailure: true },
]) {
  test(`metadata read fails closed on ${JSON.stringify(options)}`, async () => {
    await assert.rejects(checkCurrentMetadata(options));
  });
}

// Invalid or unavailable evidence must reach the bounded wait, never success.
for (const options of [
  {
    cutoff: "2026-11-07T00:01:00Z",
    proofChanges: { eventUpdatedAt: "2026-11-07T00:00:00Z" },
  },
  { cutoff: "2026-11-07T00:02:00Z" },
  { proofChanges: { target: "acp-runtime" } },
  { proofChanges: { headRepository: "foreign/repo" } },
  { proofChanges: { attempt: "0" } },
  { proofChanges: { head: "d".repeat(40) } },
  { proofChanges: { base: "invalid" } },
  { artifactChanges: { expired: true } },
  { artifactChanges: { size_in_bytes: 65537 } },
  { artifactChanges: { workflow_run: { id: 41 } } },
  { artifactChanges: { name: "other" } },
  { runChanges: { conclusion: "failure" } },
  { runChanges: { status: "in_progress", conclusion: null } },
  { runChanges: { event: "workflow_dispatch" } },
  { jobChanges: { conclusion: "skipped" } },
  { jobChanges: { conclusion: "failure" } },
]) {
  test(`evidence cannot clear gate: ${JSON.stringify(options)}`, async () => {
    await assert.rejects(checkCurrentMetadata(options), /WAITING_FOR_EVIDENCE/);
  });
}
test("fresh event after latest retarget passes without comparing current base tip", async () => {
  assert.equal(
    (await checkCurrentMetadata({ cutoff: "2026-11-07T00:01:00Z" })).failures
      .length,
    0
  );
});
test("artifact digest and archive parsing fail closed", async () => {
  await assert.rejects(
    checkCurrentMetadata({
      artifactChanges: { digest: `sha256:${"0".repeat(64)}` },
    }),
    /digest mismatch/
  );
  await assert.rejects(
    checkCurrentMetadata({ rawArchive: Buffer.from("not zip") })
  );
});
test("evidence is captured before testing using actual merge parents", () => {
  const record = job.steps.findIndex(
    (step) => step.name === "Record integration context"
  );
  const upload = job.steps.findIndex(
    (step) => step.name === "Upload integration context before validation"
  );
  assert.ok(
    record >= 0 &&
      upload > record &&
      upload < job.steps.findIndex((step) => step.name === "CI checks")
  );
  assert.match(job.steps[record].run, /rev-list.*--parents/);
  assert.match(job.steps[record].run, /eventUpdatedAt: pr.updated_at/);
  assert.equal(job.steps[upload].if, undefined);
  assert.equal(metadata.jobs.metadata["timeout-minutes"], 50);
  assert.match(metadata.jobs.metadata.steps[0].with.script, /45 \* 60 \* 1000/);
});

test("initial pending CI completes automatically without a metadata rerun", async () => {
  const result = await checkCurrentMetadata({ completeAfterWait: true });
  assert.equal(result.waits, 1);
  assert.equal(result.failures.length, 0);
});
test("bounded pending CI ends in explicit failure", async () => {
  await assert.rejects(
    checkCurrentMetadata({
      runChanges: { status: "queued", conclusion: null },
      expireWait: true,
    }),
    /unavailable or pending after 45 minutes/
  );
});
test("title edit reuses existing successful evidence immediately", async () => {
  const result = await checkCurrentMetadata({ body: "Updated review context" });
  assert.equal(result.waits, 0);
});
test("away and back retarget rejects delayed old event even with a newer upload", async () => {
  await assert.rejects(
    checkCurrentMetadata({ cutoff: "2026-11-07T00:02:30Z" }),
    /WAITING_FOR_EVIDENCE/
  );
});
test("rerunning old event with a new attempt cannot clear retarget", async () => {
  await assert.rejects(
    checkCurrentMetadata({
      cutoff: "2026-11-07T00:02:30Z",
      runChanges: { run_attempt: 2 },
      artifactChanges: { name: "ci-context-2" },
      proofChanges: { attempt: "2" },
    }),
    /WAITING_FOR_EVIDENCE/
  );
});
