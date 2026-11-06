import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
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
// This simulates the workflow's boolean/string expressions, not GitHub's
// complete expression language. Live Actions check-name/concurrency proof is
// required as well. Missing change properties use nullable fixtures here.
function evaluate(expression, context) {
  return runInNewContext(
    expression.replace(/\$\{\{(.*?)\}\}/gs, "$1"),
    context
  );
}
function event(action, changes = {}, scope = "full") {
  const context = {
    github: {
      event: {
        action,
        pull_request: { number: 123 },
        changes: { base: null, title: null, body: null, ...changes },
      },
    },
    steps: { scope: { outputs: { scope } } },
    always: () => true,
  };
  context.env = {
    PR_METADATA_ONLY: String(evaluate(job.env.PR_METADATA_ONLY, context)),
  };
  return context;
}
const group = (context) =>
  code.concurrency.group.replace(/\$\{\{(.*?)\}\}/gs, (_, expression) =>
    evaluate(expression, context)
  );
for (const changes of [
  { title: { from: "before" } },
  { body: { from: "" } },
  { title: { from: "" }, body: { from: "" } },
]) {
  test(`metadata edit ${Object.keys(changes)} cannot replace/cancel code or execute code steps`, () => {
    const context = event("edited", changes);
    assert.equal(evaluate(job.name, context), "CI routing");
    assert.equal(evaluate(job["runs-on"], context), "ubuntu-latest");
    assert.notEqual(group(context), group(event("synchronize")));
    assert.notEqual(code.concurrency.group, metadata.concurrency.group);
    assert.deepEqual(
      job.steps
        .filter((step) => !step.if || evaluate(step.if, context))
        .map((step) => step.name),
      ["Route title or body edit"]
    );
  });
}
for (const context of [
  event("opened"),
  event("synchronize"),
  event("reopened"),
  event("edited", { base: { ref: { from: "previous" } }, body: { from: "" } }),
  event("edited"),
]) {
  test(`code/base/unknown ${JSON.stringify(context.github.event)} retains validation`, () => {
    assert.equal(evaluate(job.name, context), "ci");
    assert.equal(evaluate(job["runs-on"], context), "self-hosted");
    assert.ok(
      job.steps
        .filter(
          (step) =>
            ![
              "Route title or body edit",
              "Check formatting (docs-only change)",
            ].includes(step.name)
        )
        .every((step) => !step.if || evaluate(step.if, context))
    );
    assert.equal(evaluate(job.steps[0].if, context), false);
    context.steps.scope.outputs.scope = "docs";
    assert.equal(
      evaluate(job.steps.find((step) => step.name === "CI checks").if, context),
      false
    );
    assert.equal(
      evaluate(
        job.steps.find(
          (step) => step.name === "Check formatting (docs-only change)"
        ).if,
        context
      ),
      true
    );
  });
}
test("metadata always emits independently required guard, code keeps cleanup supervisor", () => {
  assert.deepEqual(metadata.on.pull_request, code.on.pull_request);
  assert.deepEqual(code.on.pull_request.types, [
    "opened",
    "synchronize",
    "reopened",
    "edited",
  ]);
  assert.equal(metadata.jobs.metadata.name, "PR metadata");
  assert.equal(metadata.jobs.metadata.if, undefined);
  assert.equal(metadata.jobs.metadata.steps.length, 1);
  assert.equal(metadata.jobs.metadata.steps[0].if, undefined);
  assert.deepEqual(metadata.permissions, {});
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
test("hygiene rejects links, corrected metadata recovers without executing input", () => {
  for (const [body, status] of [
    ["https://claude.ai/code/session/private-id", 1],
    ["Review complete $(exit 99)", 0],
  ]) {
    const result = spawnSync(
      "bash",
      ["-c", metadata.jobs.metadata.steps[0].run],
      {
        env: { ...process.env, PR_TITLE: "PR", PR_BODY: body },
        encoding: "utf8",
      }
    );
    assert.equal(result.status, status);
    assert.ok(!result.stdout.includes("private-id"));
  }
});
