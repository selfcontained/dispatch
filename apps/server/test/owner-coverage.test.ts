import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkOwnerCoverage } from "../src/personas/coverage.js";

const roots: string[] = [];
const reviewer =
  "---\ntype: review\nname: Owner\ndescription: Owns fixtures\n---\nReview changes.\n";
const rule = (paths: string[], personas = ["owner"], exclude?: string[]) => ({
  paths,
  personas,
  ...(exclude ? { exclude } : {}),
});
function fixture(
  rules = [rule(["src/**", "docs/**", "test/**", "config.json"])]
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "owner-coverage-"));
  roots.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const write = (file: string, content = "fixture\n") => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };
  const map = (selected = rules) =>
    write(
      ".agents/owners.json",
      JSON.stringify({
        version: 1,
        rules: [rule([".agents/**"]), ...selected],
        fallback: ["code-review"],
      })
    );
  const commit = () => {
    git("add", "--all");
    git("commit", "--allow-empty", "-qm", "fixture");
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  map();
  write(".agents/personas/owner.md", reviewer);
  write("src/existing.ts");
  write("unowned-old.txt");
  const baseSha = commit();
  const check = (headSha = commit()) =>
    checkOwnerCoverage({ cwd, baseSha, headSha });
  return { cwd, git, write, map, commit, baseSha, check };
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

describe("explicit PR head owner coverage", () => {
  it("covers real additions, modifications, copies, tests, docs and config", () => {
    const f = fixture();
    for (const file of [
      "src/new.ts",
      "src/existing.ts",
      "test/new.test.ts",
      "docs/new.md",
      "config.json",
    ])
      f.write(file, "changed\n");
    f.write("src/copied.ts", "fixture\n");
    expect(f.check().changedFiles).toEqual([
      "config.json",
      "docs/new.md",
      "src/copied.ts",
      "src/existing.ts",
      "src/new.ts",
      "test/new.test.ts",
    ]);
  });

  it("fails real uncovered changes despite generalist fallback, quoting safe filenames", () => {
    const f = fixture();
    const filename = '-unowned space\t"\n$(touch nope).txt';
    f.write(filename);
    expect(() => f.check()).toThrow(
      `No explicit owner for ${JSON.stringify(filename)}`
    );
    expect(() => f.check()).toThrow("docs/code-owner-reviews.md");
  });

  it("covers unusual filenames without reading their contents", () => {
    const f = fixture();
    const files = ["src/a\nfolder/file.ts", 'src/space \t"\\$.ts'];
    for (const file of files) f.write(file, "DO NOT PRINT CONTENTS");
    expect(f.check().changedFiles).toEqual([...files].sort());
  });

  it("excludes deletions and rename sources but requires rename destinations", () => {
    const f = fixture();
    f.git("mv", "unowned-old.txt", "src/renamed.ts");
    f.git("rm", "src/existing.ts");
    expect(f.check().changedFiles).toEqual(["src/renamed.ts"]);
    f.git("mv", "src/renamed.ts", "unowned-new.txt");
    expect(() => f.check()).toThrow('No explicit owner for "unowned-new.txt"');
  });

  it("uses all overlapping rules, with rule-local exclusions", () => {
    const f = fixture([
      rule(["src/**"], ["owner"], ["src/existing.ts"]),
      rule(["src/existing.ts"], ["code-review"]),
    ]);
    f.write("src/existing.ts", "edit");
    expect(f.check().owners).toEqual(["code-review"]);
    f.map([rule(["src/**"], ["owner"], ["src/existing.ts"])]);
    expect(() => f.check()).toThrow('No explicit owner for "src/existing.ts"');
  });

  it("fails if any selected overlapping owner is invalid", () => {
    const f = fixture([rule(["src/**"]), rule(["src/**"], ["missing"])]);
    f.write("src/new.ts");
    expect(() => f.check()).toThrow('Invalid review persona "missing"');
  });

  it.each(["missing", "json", "schema", "slug"])(
    "fails closed for %s ownership map",
    (kind) => {
      const f = fixture();
      if (kind === "missing") f.git("rm", ".agents/owners.json");
      else
        f.write(
          ".agents/owners.json",
          kind === "json"
            ? "{"
            : JSON.stringify({
                version: 1,
                rules: [
                  rule(["src/**"], kind === "slug" ? ["../invalid"] : []),
                ],
              })
        );
      expect(() => f.check()).toThrow(
        "Missing or invalid PR head .agents/owners.json"
      );
    }
  );

  it.each(["missing", "empty", "task", "invalid-type", "symlink"])(
    "rejects %s selected persona",
    (kind) => {
      const f = fixture();
      f.write("src/new.ts");
      if (kind === "missing") f.git("rm", ".agents/personas/owner.md");
      else if (kind === "symlink") {
        f.git("rm", ".agents/personas/owner.md");
        mkdirSync(path.join(f.cwd, ".agents/personas"), { recursive: true });
        symlinkSync(
          "owner-target.md",
          path.join(f.cwd, ".agents/personas/owner.md")
        );
      } else
        f.write(
          ".agents/personas/owner.md",
          kind === "empty"
            ? "---\nname: Empty\n---\n"
            : reviewer.replace(
                "type: review",
                `type: ${kind === "task" ? "task" : "invalid"}`
              )
        );
      expect(() => f.check()).toThrow('Invalid review persona "owner"');
    }
  );

  it("uses head map/personas despite conflicting merge checkout and uncommitted edits", () => {
    const f = fixture([]);
    f.git("branch", "base");
    f.map([rule(["docs/**"])]);
    f.write("docs/head.md");
    const headSha = f.commit();
    f.git("checkout", "-q", "base");
    f.write("base-only.txt");
    f.map([rule(["base-only.txt"])]);
    f.commit();
    expect(() => f.git("merge", "--no-commit", "--no-ff", headSha)).toThrow();
    f.map([]); // Resolve the merge with a map that does NOT cover the PR path.
    f.commit();
    f.write(".agents/owners.json", "invalid worktree map");
    f.write(".agents/personas/owner.md", "");
    expect(
      checkOwnerCoverage({ cwd: f.cwd, baseSha: f.baseSha, headSha })
        .changedFiles
    ).toEqual([".agents/owners.json", "docs/head.md"]);
  });

  it("rejects a gap introduced by the head map even when checkout routing covers it", () => {
    const f = fixture();
    f.map([]);
    f.write("docs/uncovered.md");
    const headSha = f.commit();
    f.map([rule(["docs/**"])]);
    expect(() =>
      checkOwnerCoverage({ cwd: f.cwd, baseSha: f.baseSha, headSha })
    ).toThrow('No explicit owner for "docs/uncovered.md"');
  });

  it("preserves persona precedence and never hides an invalid primary behind legacy", () => {
    const f = fixture();
    f.write("src/new.ts");
    f.map([rule(["src/**", ".dispatch/personas/**"])]);
    f.write(".dispatch/personas/owner.md", reviewer);
    f.write(".agents/personas/owner.md", "");
    expect(() => f.check()).toThrow('Invalid review persona "owner"');
    f.git("rm", ".agents/personas/owner.md");
    expect(f.check().owners).toEqual(["owner"]);
  });

  it("runs the CI CLI on real covered and uncovered docs PR heads", () => {
    const f = fixture();
    const script = path.resolve(
      import.meta.dirname,
      "../../../scripts/ci-owner-coverage.ts"
    );
    const run = (headSha: string) =>
      spawnSync("bun", [script], {
        cwd: f.cwd,
        encoding: "utf8",
        env: { ...process.env, PR_BASE_SHA: f.baseSha, PR_HEAD_SHA: headSha },
      });
    f.write("docs/covered.md", "SECRET CONTENT");
    const covered = run(f.commit());
    expect(covered.status).toBe(0);
    expect(covered.stdout).toContain("1 PR head paths");
    f.map([]);
    const uncovered = run(f.commit());
    expect(uncovered.status).toBe(1);
    expect(uncovered.stderr).toContain(
      'No explicit owner for "docs/covered.md"'
    );
    expect(uncovered.stderr).not.toContain("SECRET CONTENT");
  });

  it("uses the merge-base diff rather than base tip changes", () => {
    const f = fixture();
    f.git("branch", "base");
    f.write("docs/head.md");
    const headSha = f.commit();
    f.git("checkout", "-q", "base");
    f.write("unowned-base-only.txt");
    const baseSha = f.commit();
    expect(
      checkOwnerCoverage({ cwd: f.cwd, baseSha, headSha }).changedFiles
    ).toEqual(["docs/head.md"]);
  });

  it("fails closed for missing/invalid refs and Git comparison failures", () => {
    const f = fixture();
    for (const baseSha of ["", "--bad", "0".repeat(40)])
      expect(() =>
        checkOwnerCoverage({ cwd: f.cwd, baseSha, headSha: f.baseSha })
      ).toThrow();
    for (const headSha of ["", "--bad", "0".repeat(40)])
      expect(() =>
        checkOwnerCoverage({ cwd: f.cwd, baseSha: f.baseSha, headSha })
      ).toThrow();
    for (const command of ["diff", "ls-tree", "show"]) {
      expect(() =>
        checkOwnerCoverage({
          cwd: f.cwd,
          baseSha: f.baseSha,
          headSha: f.baseSha,
          git: (args) => {
            if (args[0] === command) throw new Error("SECRET CONTENT");
            return f.git(...args);
          },
        })
      ).toThrow(
        /ownership coverage was not established|Missing or invalid PR head/
      );
    }
    f.git("checkout", "--orphan", "unrelated");
    f.git("rm", "-rf", ".");
    const headSha = f.commit();
    expect(() =>
      checkOwnerCoverage({ cwd: f.cwd, baseSha: f.baseSha, headSha })
    ).toThrow("merge base required");
  });

  it("wires the gate unconditionally after dependencies, including docs-only CI", () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"),
      "utf8"
    );
    const step = workflow
      .split("      - name: Require explicit PR owner coverage")[1]
      .split("      - name:")[0];
    expect(step).toContain("bun scripts/ci-owner-coverage.ts");
    expect(step).not.toContain("if:");
    expect(step).toContain("pull_request.base.sha");
    expect(step).toContain("pull_request.head.sha");
    expect(workflow.indexOf("name: Install dependencies")).toBeLessThan(
      workflow.indexOf("name: Require explicit PR owner coverage")
    );
  });
});
