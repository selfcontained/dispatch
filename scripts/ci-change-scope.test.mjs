import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classify,
  isDocsPath,
  parseRawDiff,
  scopeForCheckout,
} from "./ci-change-scope.mjs";

const entry = (path, status = "M", oldMode = "100644", newMode = "100644") => ({
  path,
  status,
  oldMode,
  newMode,
});

test("allowlists docs markdown and the root agent/TODO prose only", () => {
  for (const p of [
    "docs/19-tasks.md",
    "docs/jobs/janitor.md",
    "docs/design/a-b.md",
    "AGENTS.md",
    "CLAUDE.md",
    "TODO.md",
  ]) {
    assert.equal(isDocsPath(p), true, p);
  }
  for (const p of [
    "README.md",
    "release-notes/current.md",
    ".agents/personas/builder.md",
    "plugins/dispatch/skills/tasks/SKILL.md",
    "apps/site/src/content/docs/intro.md",
    "docs/openapi.json",
    "docs/diagram.png",
    "docs.md",
    "docs/../package.json",
    "docs/x.md/evil.ts",
    "docs/x.MD",
    "Docs/x.md",
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/ci-change-scope.mjs",
    "apps/server/src/db/migrations/001.sql",
    "apps/web/src/main.tsx",
  ]) {
    assert.equal(isDocsPath(p), false, p);
  }
});

test("docs-only edits and additions take the docs scope", () => {
  assert.deepEqual(
    classify([entry("docs/19-tasks.md"), entry("docs/new.md", "A", "000000")]),
    { scope: "docs", reasons: [] }
  );
});

test("any non-docs path forces the full scope", () => {
  const result = classify([
    entry("docs/19-tasks.md"),
    entry("apps/server/src/index.ts"),
  ]);
  assert.equal(result.scope, "full");
  assert.match(result.reasons.join("\n"), /apps\/server\/src\/index\.ts/);
});

test("deletions, type changes, executable bits and symlinks force the full scope", () => {
  assert.equal(
    classify([entry("docs/old.md", "D", "100644", "000000")]).scope,
    "full"
  );
  assert.equal(
    classify([entry("docs/x.md", "T", "100644", "120000")]).scope,
    "full"
  );
  assert.equal(
    classify([entry("docs/x.md", "M", "100644", "100755")]).scope,
    "full"
  );
  assert.equal(
    classify([entry("docs/x.md", "M", "100755", "100644")]).scope,
    "full"
  );
  assert.equal(
    classify([entry("docs/link.md", "A", "000000", "120000")]).scope,
    "full"
  );
});

test("an empty diff forces the full scope", () => {
  assert.equal(classify([]).scope, "full");
});

test("parses raw -z output, including paths with spaces and newlines", () => {
  const raw =
    ":100644 100644 abc1234 def5678 M\0docs/a b.md\0" +
    ":000000 100644 0000000 def5678 A\0docs/new\nline.md\0";
  assert.deepEqual(parseRawDiff(raw), [
    entry("docs/a b.md"),
    entry("docs/new\nline.md", "A", "000000"),
  ]);
  assert.throws(() => parseRawDiff("garbage\0x\0"), /unexpected diff record/);
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-scope-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.com");
  git("config", "user.name", "CI");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "docs"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "docs/guide.md"), "# Guide\n");
  writeFileSync(path.join(dir, "src/app.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { dir, git };
}

// Builds a PR branch with `change`, advances main independently, and checks
// out a merge commit shaped like GitHub's refs/pull/N/merge.
function prMerge({ dir, git }, change, mainChange) {
  git("checkout", "-qb", "pr");
  change(dir);
  git("add", "-A");
  git("commit", "-qm", "pr");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  if (mainChange) {
    mainChange(dir);
    git("add", "-A");
    git("commit", "-qm", "main moved");
  }
  git("checkout", "-q", "--detach", "main");
  git("merge", "-q", "--no-ff", "--no-edit", head);
  return head;
}

function inRepo(dir, fn) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}

test("a docs-only PR merge commit is docs even when main moved code meanwhile", () => {
  const r = repo();
  try {
    const head = prMerge(
      r,
      (d) => writeFileSync(path.join(d, "docs/guide.md"), "# Guide\n\nMore.\n"),
      (d) => writeFileSync(path.join(d, "src/app.ts"), "export const x = 2;\n")
    );
    assert.deepEqual(
      inRepo(r.dir, () => scopeForCheckout(head)),
      { scope: "docs", reasons: [] }
    );
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("renaming code into docs/ is full (the old path is deleted)", () => {
  const r = repo();
  try {
    const head = prMerge(r, () => r.git("mv", "src/app.ts", "docs/app.md"));
    const result = inRepo(r.dir, () => scopeForCheckout(head));
    assert.equal(result.scope, "full");
    assert.match(result.reasons.join("\n"), /src\/app\.ts/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("an executable or symlinked docs file is full", () => {
  for (const change of [
    (d) => chmodSync(path.join(d, "docs/guide.md"), 0o755),
    (d) => symlinkSync("../src/app.ts", path.join(d, "docs/link.md")),
  ]) {
    const r = repo();
    try {
      const head = prMerge(r, change);
      assert.equal(inRepo(r.dir, () => scopeForCheckout(head)).scope, "full");
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test("a checkout that is not the expected PR merge commit is full", () => {
  const r = repo();
  try {
    const head = prMerge(r, (d) =>
      writeFileSync(path.join(d, "docs/guide.md"), "# Changed\n")
    );
    assert.equal(
      inRepo(r.dir, () => scopeForCheckout("0".repeat(40))).scope,
      "full"
    );
    assert.equal(
      inRepo(r.dir, () => scopeForCheckout(undefined)).scope,
      "full"
    );
    r.git("checkout", "-q", head);
    assert.equal(inRepo(r.dir, () => scopeForCheckout(head)).scope, "full");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
