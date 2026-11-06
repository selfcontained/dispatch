import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(
  new URL("../apps/server/package.json", import.meta.url)
);
const { parse } = require("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
);
const job = workflow.jobs.ci;
function evaluate(expression, context) {
  return runInNewContext(
    expression.replace(/\$\{\{(.*?)\}\}/gs, "$1"),
    context
  );
}
function event(action, changes = {}) {
  const github = {
    event: {
      action,
      pull_request: { number: 123 },
      changes: { base: null, title: null, body: null, ...changes },
    },
  };
  const context = {
    github,
    always: () => true,
    steps: { scope: { outputs: { scope: "full" } } },
  };
  context.env = {
    PR_METADATA_ONLY: String(evaluate(job.env.PR_METADATA_ONLY, context)),
  };
  return context;
}
for (const changes of [
  { title: { from: "before" } },
  { body: { from: "before" } },
  { title: { from: "" }, body: { from: "" } },
]) {
  test(`metadata edit ${Object.keys(changes)} cannot replace or cancel ci`, () => {
    const context = event("edited", changes);
    assert.equal(evaluate(job.name, context), "PR metadata");
    assert.equal(evaluate(job["runs-on"], context), "ubuntu-latest");
    const group = (c) =>
      workflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/gs, (_, expr) =>
        evaluate(expr, c)
      );
    assert.notEqual(group(context), group(event("synchronize")));
    const runnable = job.steps.filter(
      (step) => !step.if || evaluate(step.if, context)
    );
    assert.equal(runnable.length, 1);
    assert.match(runnable[0].name, /session links/);
  });
}
for (const context of [
  event("opened"),
  event("synchronize"),
  event("reopened"),
  event("edited", { base: { ref: { from: "main" } }, body: { from: "" } }),
  event("edited"),
]) {
  test(`code/base/unknown event ${JSON.stringify(context.github.event)} validates`, () => {
    assert.equal(evaluate(job.name, context), "ci");
    assert.equal(evaluate(job["runs-on"], context), "self-hosted");
    assert.ok(
      job.steps
        .filter((step) => step.name !== "Check formatting (docs-only change)")
        .every((step) => !step.if || evaluate(step.if, context))
    );
    context.steps.scope.outputs.scope = "docs";
    assert.ok(
      !evaluate(job.steps.find((step) => step.name === "CI checks").if, context)
    );
    assert.ok(
      evaluate(
        job.steps.find(
          (step) => step.name === "Check formatting (docs-only change)"
        ).if,
        context
      )
    );
  });
}
test("hygiene rejects session links without logging their contents", () => {
  const script = job.steps[0].run;
  for (const [body, status] of [
    ["Review complete", 0],
    ["https://claude.ai/code/session/private-id", 1],
  ]) {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PR_TITLE: "PR", PR_BODY: body },
      encoding: "utf8",
    });
    assert.equal(result.status, status);
    assert.ok(!result.stdout.includes("private-id"));
  }
});
test("workflow keeps all relevant PR events", () => {
  assert.deepEqual(workflow.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "edited",
  ]);
});

test("correcting failed initial hygiene requires reopening for code validation", () => {
  const failed = spawnSync("bash", ["-c", job.steps[0].run], {
    env: {
      ...process.env,
      PR_TITLE: "PR",
      PR_BODY: "https://claude.ai/code/session/private-id",
    },
    encoding: "utf8",
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /close and reopen the PR/);
  const corrected = event("edited", { body: { from: "old link" } });
  assert.equal(evaluate(job.name, corrected), "PR metadata");
  assert.equal(
    evaluate(job.steps.find((step) => step.name === "CI checks").if, corrected),
    false
  );
  const reopened = event("reopened");
  assert.equal(evaluate(job.name, reopened), "ci");
  assert.equal(
    evaluate(job.steps.find((step) => step.name === "CI checks").if, reopened),
    true
  );
});
