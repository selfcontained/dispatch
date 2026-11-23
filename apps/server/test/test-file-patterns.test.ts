/*
 * The test-file rule sent as a runner's `exclude` patterns must decide every
 * path exactly as `isTestFile` does.
 */
import { describe, expect, it } from "vitest";
import {
  isTestFile,
  TEST_FILE_PATTERNS,
} from "../src/shared/lib/test-file-rule.js";
import { excludeMatcher } from "../src/agents/checkout-worker.js";

const dirs = [
  "",
  "src/",
  "a/b/",
  "test/",
  "tests/x/",
  "__tests__/",
  "e2e/",
  "Spec/",
  "cypress/",
  "playwright/",
  "src\\win\\",
  "testing/",
  "contest/",
  "src/.test/",
  "a.test/",
  "specs/deep/",
];
const names = [
  "foo.ts",
  "foo.test.ts",
  "foo.spec.tsx",
  "foo-test.js",
  "foo_test.go",
  "foo_test.py",
  "foo_test.md",
  "test_foo.py",
  "TEST_FOO.PY",
  "test_fixtures.json",
  "FooTest.java",
  "FooTests.kt",
  "FooSpec.swift",
  "footest.java",
  "FooTEST.java",
  "FooTest.JAVA",
  "api-spec.md",
  "test.ts",
  "spec.rb",
  "x.test",
  "test.",
  "Foo.Test.CS",
  "a.test.d.ts",
  "foo.spec.feature",
  "conftest.py",
  "main_test.rs",
  "x.test.ts.bak",
  "readme",
  ".test.ts",
  "test_.sh",
  "foo.TEST.ts",
];

describe("TEST_FILE_PATTERNS", () => {
  const excluded = excludeMatcher(TEST_FILE_PATTERNS);
  it.each(dirs.flatMap((dir) => names.map((name) => dir + name)))(
    "%s",
    (path) => expect(excluded(path)).toBe(isTestFile(path))
  );
  it("are regular-expression literals", () => {
    for (const pattern of TEST_FILE_PATTERNS)
      expect(pattern).toMatch(/^\/.+\/[a-z]*$/s);
  });
  it("refuse a pattern that is not a literal", () => {
    expect(() => excludeMatcher(["*.test.ts"])).toThrow(/Invalid exclude/);
  });
});
