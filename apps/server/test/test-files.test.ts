import { describe, expect, it } from "vitest";

import { isTestFile } from "../src/shared/git/test-files.js";

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
    "test/fixtures/user.json",
    "src/__tests__/snapshot.json",
    "haskell/AuthSpec.hs",
    "features/checkout_spec.feature",
    "julia/test_solver.jl",
    "ocaml/test_parser.ml",
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
    "docs/03-api-spec.md",
    "docs/openapi-spec.json",
    "config/test_defaults.json",
    "tsconfig.test.json",
    "src/schema.spec.graphql",
    "src/Protest.kt",
    "src/Latest.swift",
  ])("does not hide %s", (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});
