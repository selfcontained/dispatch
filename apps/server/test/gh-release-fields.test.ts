import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Validates that the JSON field names used in `gh release list` calls
 * throughout the codebase are actually supported by the gh CLI.
 *
 * This test exists because `gh release list --json` and `gh release view --json`
 * support different field sets. Using an invalid field (e.g. "url" on list)
 * causes a silent failure that breaks the releases admin UI.
 */

const GH_AVAILABLE = (() => {
  try {
    execSync("gh --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

function getAvailableFields(subcommand: "list" | "view"): string[] {
  // gh release list --json x gives an error listing valid fields
  try {
    execSync(`gh release ${subcommand} --json __invalid_field__ 2>&1`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return [];
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const output = stderr + stdout;
    // Extract field names from "Available fields:" section
    const match = output.match(/Available fields:\n([\s\S]+?)(?:\n\n|$)/);
    if (!match) return [];
    return match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

describe.skipIf(!GH_AVAILABLE)("gh release list JSON fields", () => {
  it("supports the fields used by GET /api/v1/releases", () => {
    const available = getAvailableFields("list");
    expect(available.length).toBeGreaterThan(0);

    // Fields used in GET /api/v1/releases
    for (const field of ["tagName", "publishedAt", "isPrerelease"]) {
      expect(available, `field "${field}" should be available on gh release list`).toContain(field);
    }
  });

  it("supports the fields used by GET /api/v1/release/info", () => {
    const available = getAvailableFields("list");
    expect(available.length).toBeGreaterThan(0);

    // Fields used in the channel-aware tag resolution
    for (const field of ["tagName", "isPrerelease"]) {
      expect(available, `field "${field}" should be available on gh release list`).toContain(field);
    }
  });

  it("does NOT support 'url' on gh release list (regression guard)", () => {
    const available = getAvailableFields("list");
    expect(available.length).toBeGreaterThan(0);

    // url is only available on `gh release view`, not `gh release list`.
    // This test guards against accidentally adding it back.
    expect(available).not.toContain("url");
  });
});
