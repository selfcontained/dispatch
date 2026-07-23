import { describe, expect, it } from "vitest";

import { excludeTestFiles, isTestFile } from "./test-files";

describe("isTestFile", () => {
  it.each([
    "src/components/button.test.tsx",
    "src/components/button.spec.tsx",
    "src/components/button-test.tsx",
    "src/__tests__/button.tsx",
    "tests/integration/auth.py",
    "test/routes/users_test.rb",
    "internal/widget_test.go",
    "test_api.py",
    "src/AppTest.java",
    "src/AppTests.java",
    "src/AppSpec.kt",
    "cypress/e2e/login.cy.ts",
  ])("recognizes %s as a test file", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "src/components/button.tsx",
    "testdata/example.json",
    "src/testing-helpers.ts",
    "src/specification.ts",
    "src/widget.test.helper.ts",
    "fixtures/test-user.json",
    "src/Contest.java",
    "src/Protest.kt",
    "src/Latest.swift",
  ])("does not hide %s", (path) => {
    expect(isTestFile(path)).toBe(false);
  });

  it("keeps an explicitly navigated test file visible", () => {
    const files = [{ path: "src/app.ts" }, { path: "src/app.test.ts" }];

    expect(excludeTestFiles(files, "src/app.test.ts")).toEqual(files);
    expect(excludeTestFiles(files, null)).toEqual([{ path: "src/app.ts" }]);
  });
});
