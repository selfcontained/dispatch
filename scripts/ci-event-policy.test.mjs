import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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

test("seeding retains existing required code enforcement on edits", () => {
  assert.equal(code.jobs.ci.name, undefined);
  assert.equal(code.jobs.ci.if, undefined);
  assert.equal(code.jobs.ci["runs-on"], "self-hosted");
  assert.ok(code.on.pull_request.types.includes("edited"));
  assert.match(code.jobs.ci.steps[0].name, /session links/);
  assert.equal(code.jobs.ci.steps[0].if, undefined);
});
test("metadata always emits its exact check without code or dependencies", () => {
  assert.deepEqual(metadata.on.pull_request, code.on.pull_request);
  assert.equal(metadata.jobs.metadata.name, "PR metadata");
  assert.equal(metadata.jobs.metadata.if, undefined);
  assert.equal(metadata.jobs.metadata["runs-on"], "ubuntu-latest");
  assert.equal(metadata.jobs.metadata.steps.length, 1);
  assert.equal(metadata.jobs.metadata.steps[0].if, undefined);
  assert.equal(metadata.jobs.metadata.steps[0].uses, undefined);
  assert.deepEqual(metadata.permissions, {});
  assert.notEqual(metadata.concurrency.group, code.concurrency.group);
  assert.equal(metadata.jobs.metadata.steps[0].run, code.jobs.ci.steps[0].run);
});
test("bad metadata blocks, corrected metadata recovers, neither executes input", () => {
  const script = metadata.jobs.metadata.steps[0].run;
  for (const [body, status] of [
    ["https://claude.ai/code/session/private-id", 1],
    ["Review complete $(exit 99)", 0],
  ]) {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PR_TITLE: "PR", PR_BODY: body },
      encoding: "utf8",
    });
    assert.equal(result.status, status);
    assert.ok(!result.stdout.includes("private-id"));
  }
});
