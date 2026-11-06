import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

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
    "edited",
  ]);
  assert.deepEqual(metadata.on.pull_request, code.on.pull_request);
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
  head = "head",
  target = "main",
  state = "open",
  race = false,
  apiFailure = false,
} = {}) {
  const failures = [];
  const logs = [];
  let reads = 0;
  const expected = {
    head: { sha: "head", repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
    body: "claude.ai/code/session/stale-event",
  };
  const github = {
    rest: {
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
    }
  );
  return { failures, logs, reads };
}
test("metadata uses only PR read permission and never publishes custom checks", () => {
  assert.deepEqual(metadata.jobs.metadata.permissions, {
    "pull-requests": "read",
  });
  assert.equal(
    metadata.jobs.metadata.steps[0].uses,
    "actions/github-script@v8"
  );
});
test("retry reads corrected current metadata despite the original bad event", async () => {
  const result = await checkCurrentMetadata();
  assert.equal(result.failures.length, 0);
  assert.equal(result.reads, 2);
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
