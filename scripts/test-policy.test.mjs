import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectedCases,
  inspectSource,
  validatePolicy,
} from "./test-policy.mjs";
const file = "e2e/example.spec.ts";
const source =
  'test("a", async ({ page }) => { await page.waitForTimeout(100); });';
function fixture() {
  return {
    version: 1,
    files: {
      [file]: {
        owner: "testing-strategy-owner",
        layer: "browser",
        risk: "Native focus regression",
        browserReason: "Requires actual browser focus and keyboard events",
        cases: ["a"],
        exceptions: inspectSource(source).map(({ key }) => ({
          key,
          count: 1,
          owner: "testing-strategy-owner",
          reason: "Existing wait to replace with event readiness",
          expires: "2026-12-01",
        })),
      },
    },
  };
}
const check = (policy = fixture(), cases = ["a"], code = source) =>
  validatePolicy(policy, { [file]: cases }, { [file]: code }, "2026-11-05");
test("accepts a documented bounded migration baseline", () =>
  assert.deepEqual(check(), []));
test("requires admission for a new file and rejects stale entries", () => {
  assert.match(validatePolicy(fixture(), {}, {}, "2026-11-05").join(), /stale/);
  assert.match(
    check({ version: 1, files: {} }).join(),
    /missing browser admission/
  );
});
test("catches added, removed, renamed and duplicate collected cases including viewport expansion", () => {
  for (const titles of [["a", "mobile"], ["b"], ["a", "a"], []])
    assert.ok(check(fixture(), titles).length);
});
test("rejects increased waits and extra copies even within an admitted test", () => {
  assert.match(
    check(fixture(), ["a"], source.replace("100", "200")).join(),
    /exception/
  );
  assert.match(
    check(fixture(), ["a"], source + "page.waitForTimeout(100);").join(),
    /exception/
  );
});
test("does not mistake strings or comments for risky calls", () => {
  assert.deepEqual(
    inspectSource('// page.waitForTimeout(99)\nconst doc = "test.skip()";'),
    []
  );
});
test("comments and formatting do not invalidate an existing exception", () => {
  assert.deepEqual(
    check(fixture(), ["a"], source.replace("100", "/* rationale */ 100")),
    []
  );
});
test("exceptions expire; removed risks require baseline cleanup", () => {
  const p = fixture();
  p.files[file].exceptions[0].expires = "2026-11-04";
  assert.match(check(p).join(), /exception/);
  assert.match(
    check(fixture(), ["a"], 'test("a", () => {});').join(),
    /stale exception/
  );
});
test("rejects skips, retries, timeout overrides and sleeps without exceptions", () => {
  for (const code of [
    "test.skip();",
    "test.slow();",
    "test.setTimeout(60000);",
    "test.describe.configure({ retries: 3 });",
    "expect(x).toBeVisible({ timeout: 9000 });",
    "setTimeout(resolve, 100);",
  ]) {
    assert.ok(inspectSource(code).length, code);
    assert.match(check(fixture(), ["a"], code).join(), /exception/);
  }
});
test("only and networkidle cannot be exempted", () => {
  for (const code of [
    'test.only("x", () => {});',
    'page.goto("/", {waitUntil: "networkidle"});',
  ])
    assert.match(check(fixture(), ["a"], code).join(), /forbidden/);
});
test("collection errors and empty selection fail closed", () => {
  assert.throws(
    () => collectedCases({ errors: [{ message: "broken" }] }),
    /errors/
  );
  assert.throws(() => collectedCases({ suites: [] }), /no tests/);
  assert.deepEqual(
    collectedCases({
      suites: [
        {
          title: "example.spec.ts",
          file: "example.spec.ts",
          suites: [
            {
              title: "Flow",
              file: "example.spec.ts",
              specs: [{ file: "example.spec.ts", title: "a", tests: [{}, {}] }],
            },
          ],
        },
      ],
    }),
    { [file]: ["Flow > a", "Flow > a"] }
  );
});

test("a spec cannot use the support category to hide an uncollected test", () => {
  const p = fixture();
  p.files[file].layer = "support";
  p.files[file].cases = [];
  assert.match(check(p, []).join(), /support entries/);
});

test("rejects malformed expiry dates and default timeout setters", () => {
  const p = fixture();
  p.files[file].exceptions[0].expires = "2027-99-99";
  assert.match(check(p).join(), /exception/);
  assert.ok(inspectSource("page.setDefaultTimeout(90000);").length);
  assert.ok(inspectSource("page.setDefaultNavigationTimeout(90000);").length);
});

test("rejects shorthand timeout/retry options even with an exception", () => {
  for (const option of [
    "timeout",
    "retries",
    "actionTimeout",
    "navigationTimeout",
  ]) {
    const code = `const ${option} = 60000; test.describe.configure({ ${option} });`;
    const risks = inspectSource(code);
    assert.equal(risks.length, 1);
    assert.equal(risks[0].rule, "shorthand-timeout-or-retry");
    const p = fixture();
    p.files[file].exceptions = [
      {
        key: risks[0].key,
        count: 1,
        owner: "testing-strategy-owner",
        reason: "Cannot approve an unresolved binding",
        expires: "2027-01-01",
      },
    ];
    assert.match(check(p, ["a"], code).join(), /forbidden/);
  }
  const code =
    'const timeout = 60000; const retries = 3; test.describe.configure({ retries }); test("a", async ({ page }) => { await expect(page.locator("button")).toBeVisible({ timeout }); });';
  const p = fixture();
  p.files[file].exceptions = [];
  assert.equal(
    check(p, ["a"], code).filter((error) => error.includes("forbidden")).length,
    2
  );
});
