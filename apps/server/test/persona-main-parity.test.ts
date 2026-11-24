/*
 * Local persona discovery and resolution as origin/main does them. Every
 * expectation here was taken from main's `discoverPersonas` and
 * `resolveLaunchPersona` on the same fixture. An agent's session scope
 * (reads through its checkout) must answer exactly as main's folder scope
 * did for that agent's workspace.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectCheckout } from "../src/agents/checkout-inspection.js";
import { personaScopeFor } from "../src/personas/persona-scope.js";
import { listPersonas, resolvePersona } from "../src/personas/resolve.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

let root: string;
let worktree: string;

const session = () =>
  personaScopeFor({
    manager: {
      inspectCheckout: (_agent, query) =>
        inspectCheckout(worktree, query, { recordedBase: false }),
    },
    agent: { id: "agent" } as never,
  });
const folder = () => personaScopeFor({ cwd: worktree, source: "workspace" });

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "persona-main-parity-"));
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const checkout = path.join(root, "checkout");
  worktree = path.join(root, "worktree");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", origin, author], { stdio: "pipe" });
  git(author, "config", "user.email", "test@example.com");
  git(author, "config", "user.name", "test");
  await mkdir(path.join(author, ".agents/personas"), { recursive: true });
  await mkdir(path.join(author, ".dispatch/personas"), { recursive: true });
  await writeFile(
    path.join(author, ".agents/personas/builder.md"),
    "---\ntype: task\nname: B\ndescription: d\n---\nremote"
  );
  await writeFile(
    path.join(author, ".dispatch/personas/legacy.md"),
    "---\nname: L\ndescription: d\n---\nlegacy remote"
  );
  await writeFile(
    path.join(author, ".agents/personas/bad.md"),
    "---\ntype: typo\n---\nbad"
  );
  git(author, "add", ".");
  git(author, "commit", "-m", "personas");
  git(author, "push", "origin", "main");
  execFileSync("git", ["clone", origin, checkout], { stdio: "pipe" });
  git(checkout, "worktree", "add", "-b", "work", worktree);
  await mkdir(path.join(worktree, ".agents/personas"), { recursive: true });
  await writeFile(
    path.join(worktree, ".agents/personas/builder.md"),
    "---\ntype: task\n---\nlocal override"
  );
  await writeFile(
    path.join(worktree, ".agents/personas/zz.md"),
    "---\ntype: typo\n---\nbroken local"
  );
  // Warm the catalog, as main's tests do.
  await listPersonas(folder(), undefined, true);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const MAIN_WARNINGS = [
  "Could not load persona .agents/personas/bad.md: invalid persona definition.",
  'Could not load persona .agents/personas/bad.md: Invalid persona type "typo" in bad. Expected review or task.',
  'Could not load persona .agents/personas/zz.md: Invalid persona type "typo" in zz. Expected review or task.',
];

describe("local personas match origin/main", () => {
  it("lists catalog warnings before the checkout's own, in both scopes", async () => {
    for (const scope of [folder(), session()]) {
      const listed = await listPersonas(scope, undefined, true);
      expect(listed.personas.map((p) => [p.slug, p.body])).toEqual([
        ["builder", "local override"],
        ["legacy", "legacy remote"],
        ["code-review", expect.any(String)],
      ]);
      expect(listed.warnings).toEqual(MAIN_WARNINGS);
    }
  });

  it("skips an unreadable persona directory without a warning", async () => {
    const legacyDir = path.join(worktree, ".dispatch/personas");
    await rename(legacyDir, `${legacyDir}.aside`);
    await writeFile(legacyDir, "not a dir");
    try {
      for (const scope of [folder(), session()])
        expect((await listPersonas(scope, undefined, true)).warnings).toEqual(
          MAIN_WARNINGS
        );
    } finally {
      await rm(legacyDir, { force: true });
      await rename(`${legacyDir}.aside`, legacyDir);
    }
  });

  it("names a missing persona as main does", async () => {
    for (const scope of [folder(), session()])
      await expect(resolvePersona(scope, "nope")).rejects.toThrow(
        /^Persona "nope" not found\.$/
      );
  });

  it("waits for a refreshing catalog before falling back to built-ins", async () => {
    const common = git(
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    ).trim();
    const identity = createHash("sha256")
      .update(git(worktree, "remote", "get-url", "origin").trim())
      .digest("hex");
    const cache = path.join(
      common,
      "dispatch",
      "default-branch",
      `${identity}.json`
    );
    const legacy = path.join(
      common,
      "dispatch",
      "persona-catalog",
      `${identity}.json`
    );
    // Another server holds a cold refresh: no published catalog yet.
    await rm(cache, { force: true });
    await rm(legacy, { force: true });
    await mkdir(`${cache}.lock`, { recursive: true });
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        nextRefreshAt: Date.now() + 3_600_000,
        failures: 0,
        updatedAt: 1,
        commit: null,
        warnings: [],
        personas: [],
      })
    );
    try {
      await expect(resolvePersona(session(), "code-review")).rejects.toThrow(
        "Persona catalog is still refreshing. Try again shortly."
      );
    } finally {
      await rm(`${cache}.lock`, { recursive: true, force: true });
      await rm(legacy, { force: true });
    }
  });
});
