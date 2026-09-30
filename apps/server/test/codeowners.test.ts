import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectOwnerReviewFiles,
  launchOwnerReviewPlan,
  loadCodeowners,
  matchesOwnerPattern,
  resolveCodeowners,
  type CodeownersConfig,
} from "../src/personas/codeowners.js";
import { runCommand } from "../src/shared/lib/run-command.js";
import { loadPersonas } from "../src/personas/loader.js";

const temporary: string[] = [];
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-owners-"));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});
const config: CodeownersConfig = {
  version: 1,
  rules: [
    {
      paths: ["src/**"],
      personas: ["runtime-owner"],
      exclude: ["src/generated/**"],
    },
    {
      paths: ["src/reviews/*", "test/reviews*"],
      personas: ["reviews-owner", "runtime-owner"],
    },
  ],
  fallback: ["code-review"],
};

describe("code owner routing", () => {
  it.each([
    ["src/a.ts", "src/**", true],
    ["src/a.ts", "src/**/*.ts", true],
    ["src/deep/a.ts", "src/**/*.ts", true],
    ["src/deep/a.ts", "src/*.ts", false],
    ["test/reviews.test.ts", "test/reviews*", true],
    ["other/src/a.ts", "src/**", false],
    ["x/a.ts", "**/a.ts", true],
    ["a.ts", "**/a.ts", true],
    ["a1.ts", "a?.ts", true],
    ["a11.ts", "a?.ts", false],
    ["file+.ts", "file+.ts", true],
    ["file.ts", "file+.ts", false],
  ])("matches %s against %s: %s", (file, pattern, expected) => {
    expect(matchesOwnerPattern(file, pattern)).toBe(expected);
  });
  it("unions overlapping owners once, applies local exclusions, and reports fallback gaps", () => {
    const plan = resolveCodeowners(
      config,
      [
        "src/reviews/a.ts",
        "src/reviews/a.ts",
        "src/generated/a.ts",
        "test/reviews.test.ts",
        "README.md",
      ],
      "main"
    );
    expect(plan.owners).toEqual([
      { persona: "code-review", files: ["README.md", "src/generated/a.ts"] },
      {
        persona: "runtime-owner",
        files: ["src/reviews/a.ts", "test/reviews.test.ts"],
      },
      {
        persona: "reviews-owner",
        files: ["src/reviews/a.ts", "test/reviews.test.ts"],
      },
    ]);
    expect(plan.uncoveredFiles).toEqual(["README.md", "src/generated/a.ts"]);
  });
  it("does not let one rule's exclusion suppress another owner", () => {
    const plan = resolveCodeowners(
      {
        version: 1,
        rules: [
          { paths: ["src/**"], exclude: ["src/a.ts"], personas: ["one"] },
          { paths: ["src/a.ts"], personas: ["two"] },
        ],
      },
      ["src/a.ts"],
      "main"
    );
    expect(plan.owners).toEqual([{ persona: "two", files: ["src/a.ts"] }]);
  });
  it("handles no changes and uncovered files without a fallback", () => {
    expect(resolveCodeowners(config, [], "main").owners).toEqual([]);
    expect(
      resolveCodeowners(
        { ...config, fallback: undefined },
        ["README.md"],
        "main"
      ).owners
    ).toEqual([]);
  });
  it("loads strict workspace configuration and rejects invalid maps", async () => {
    const root = await workspace();
    await expect(loadCodeowners(root)).rejects.toThrow(
      "No .dispatch/codeowners.json"
    );
    await mkdir(path.join(root, ".dispatch"));
    await writeFile(
      path.join(root, ".dispatch/codeowners.json"),
      JSON.stringify(config)
    );
    expect(await loadCodeowners(root)).toEqual(config);
    for (const invalid of [
      { ...config, version: 2 },
      { ...config, rules: [{ paths: ["../outside/**"], personas: ["one"] }] },
      { ...config, rules: [{ paths: ["src/**"], personas: ["../owner"] }] },
      { ...config, rules: [{ paths: ["/src/**"], personas: ["one"] }] },
      { ...config, rules: [{ paths: ["src/{a,b}"], personas: ["one"] }] },
      { ...config, typo: true },
    ]) {
      await writeFile(
        path.join(root, ".dispatch/codeowners.json"),
        JSON.stringify(invalid)
      );
      await expect(loadCodeowners(root)).rejects.toThrow(
        "Invalid .dispatch/codeowners.json"
      );
    }
    await writeFile(path.join(root, ".dispatch/codeowners.json"), "{");
    await expect(loadCodeowners(root)).rejects.toThrow(
      "Invalid .dispatch/codeowners.json"
    );
  });
  it("collects committed, staged, unstaged, untracked, deleted and both renamed paths from real git", async () => {
    const root = await workspace();
    const git = (args: string[]) => runCommand("git", args, { cwd: root });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    for (const file of ["old.ts", "unstaged.ts", "staged.ts", "deleted.ts"])
      await writeFile(path.join(root, file), "base");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await rename(path.join(root, "old.ts"), path.join(root, "new.ts"));
    await git(["add", "."]);
    await git(["commit", "-m", "rename"]);
    await writeFile(path.join(root, "staged.ts"), "staged");
    await git(["add", "staged.ts"]);
    await writeFile(path.join(root, "unstaged.ts"), "unstaged");
    await unlink(path.join(root, "deleted.ts"));
    await writeFile(path.join(root, " leading space.ts"), "new");
    await git(["add", " leading space.ts"]);
    await writeFile(path.join(root, "line\nbreak.ts"), "new");
    expect(await collectOwnerReviewFiles(root, "HEAD~1", runCommand)).toEqual([
      " leading space.ts",
      "deleted.ts",
      "line\nbreak.ts",
      "new.ts",
      "old.ts",
      "staged.ts",
      "unstaged.ts",
    ]);
    await expect(
      collectOwnerReviewFiles(root, "missing-base", runCommand)
    ).rejects.toThrow("Command failed");
  });
  it("keeps successful launches visible when another owner fails, and passes scope before context", async () => {
    const plan = resolveCodeowners(
      config,
      ["src/reviews/a.ts", "README.md"],
      "main"
    );
    const launch = vi.fn(async (persona: string) => {
      if (persona === "runtime-owner") throw new Error("runtime unavailable");
      return { agentId: `agent-${persona}` };
    });
    const result = await launchOwnerReviewPlan(
      plan,
      "Changed review delivery",
      launch
    );
    expect(result.launched.map((owner) => owner.persona)).toEqual([
      "code-review",
      "reviews-owner",
    ]);
    expect(result.failures).toEqual([
      {
        persona: "runtime-owner",
        files: ["src/reviews/a.ts"],
        error: "runtime unavailable",
      },
    ]);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(launch.mock.calls[1][1]).toContain("src/reviews/a.ts");
    expect(launch.mock.calls[1][1]).toContain("Changed review delivery");
    expect(launch.mock.calls[1][1]).toMatch(/^## Code ownership scope/);
  });
  it("preserves the briefing when an owner matches a large change", async () => {
    const files = Array.from(
      { length: 500 },
      (_, i) => `src/large-module-${i}.ts`
    );
    const plan = resolveCodeowners(config, files, "main");
    const launch = vi.fn(async (_persona: string, _context: string) => ({
      agentId: "reviewer",
    }));
    await launchOwnerReviewPlan(plan, "Verify the new contract", launch);
    const briefing = launch.mock.calls[0][1];
    expect(briefing).toContain("more matched paths omitted");
    expect(briefing).toContain("Verify the new contract");
    expect(Buffer.byteLength(briefing)).toBeLessThan(2200);
    expect(plan.owners[0].files).toHaveLength(500);
  });
  it("Dispatch's ownership map selects actual subsystem personas", async () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const repoConfig = await loadCodeowners(root);
    const personas = await loadPersonas(root);
    const names = new Set([...personas.map((p) => p.slug), "code-review"]);
    for (const rule of repoConfig.rules)
      for (const slug of rule.personas) expect(names.has(slug)).toBe(true);
    const plan = resolveCodeowners(
      repoConfig,
      [
        "apps/server/src/personas/codeowners.ts",
        "apps/server/src/shared/mcp/server.ts",
        "apps/web/src/components/app/chat/block-bodies.tsx",
        "README.md",
      ],
      "main"
    );
    expect(plan.owners.map((owner) => owner.persona)).toEqual(
      expect.arrayContaining([
        "review-lifecycle-owner",
        "mcp-contract-owner",
        "stream-interactions-owner",
        "code-review",
      ])
    );
  });
});
