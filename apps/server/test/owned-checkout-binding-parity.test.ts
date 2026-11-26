import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { checkoutHandlers } from "../../../packages/runner/src/core/checkout.js";
import {
  bindingFromRow,
  type LocalBindingRow,
} from "../src/runners/local-bindings.js";
import { resolvePath } from "../src/agents/workspace.js";
import {
  loadCodeowners,
  parseCodeowners,
  type CodeownersConfig,
} from "./helpers/codeowners.js";
import { buildMergeRiskEvidence } from "../src/agents/merge-risk/evidence.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";

async function owners(root: string, name: string) {
  await mkdir(path.join(root, ".agents"), { recursive: true });
  await writeFile(
    path.join(root, ".agents/owners.json"),
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["src/**"], personas: [name] }],
    })
  );
}
function evidence(config: CodeownersConfig | null) {
  return buildMergeRiskEvidence({
    pullRequest: {
      number: 1,
      title: "Fixture",
      body: "",
      baseRef: "main",
      headRef: "topic",
      additions: 1,
      deletions: 0,
    },
    files: [{ path: "src/service.ts", additions: 1, deletions: 0 }],
    owners: config,
    reviews: [],
    briefing: "",
    ci: { status: "unknown" },
  } as never).change_summary.subsystems;
}
function row(
  cwd: string,
  worktreePath: string | null,
  workspacePath: string | null
): LocalBindingRow {
  return {
    id: "owner-pin",
    cwd,
    worktreePath,
    workspacePath,
    worktreeBranch: "work",
    baseBranch: "main",
  };
}
async function bindingRead(store: BindingStore) {
  const handlers = checkoutHandlers(store, { workload: checkoutWorkload });
  try {
    // Before adding owned: core's existing launch selector already names the
    // immutable binding checkout. Do not route the local adapter through it.
    const reply = await handlers["checkout.read"]!(
      {
        target: { session: sessionFromWire("owner-pin"), checkout: "launch" },
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
      },
      {
        emit() {},
        receiveBlob: async () => {
          throw new Error("unused");
        },
      }
    );
    return reply ? parseCodeowners(reply.data) : null;
  } catch {
    return null;
  }
}

it("pins main owner output and binding roots through moves, reopen and repeated preparation", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "owned-binding-"))
  );
  const repo = path.join(root, "main"),
    worktree = path.join(root, "work"),
    moved = path.join(root, "moved"),
    plain = path.join(root, "plain");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    await mkdir(repo);
    await mkdir(moved);
    await mkdir(plain);
    git("init", "--quiet");
    await owners(repo, "main-owner");
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "pin"
    );
    git("worktree", "add", "--quiet", "-b", "work", worktree);
    await owners(worktree, "worktree-owner");
    await owners(moved, "moved-owner");
    await owners(plain, "folder-owner");
    await mkdir(path.join(moved, "sub"));
    for (const [name, agent, expected] of [
      ["worktree", row(repo, worktree, null), { "worktree-owner": 1 }],
      ["no-worktree", row(repo, null, null), { "main-owner": 1 }],
      ["moved-repository", row(repo, worktree, moved), { "worktree-owner": 1 }],
      [
        "moved-subfolder",
        row(repo, worktree, path.join(moved, "sub")),
        { "worktree-owner": 1 },
      ],
      ["gone-worktree", row(repo, path.join(root, "gone"), moved), {}],
      ["non-repository", row(plain, null, null), { "folder-owner": 1 }],
    ] as const) {
      const home = agent.worktreePath ?? agent.cwd!;
      expect(evidence(await loadCodeowners(home).catch(() => null))).toEqual(
        expected
      );
      const state = path.join(root, name),
        store = new BindingStore(state);
      const initial = bindingFromRow({ ...agent, workspacePath: null })!;
      await store.import([initial]);
      if (agent.workspacePath)
        await store.select(agent.id, agent.workspacePath);
      expect((await store.get(agent.id))?.checkout.path).toBe(home);
      expect(evidence(await bindingRead(store))).toEqual(expected);
      const reopened = new BindingStore(state);
      await reopened.import([bindingFromRow(agent)]);
      expect((await reopened.get(agent.id))?.checkout.path).toBe(home);
      await reopened.bindPrepared(bindingFromRow(agent)!);
      await reopened.bindPrepared(bindingFromRow(agent)!);
      expect((await new BindingStore(state).get(agent.id))?.checkout.path).toBe(
        home
      );
      expect(evidence(await bindingRead(reopened))).toEqual(expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("pins an accepted path with a retained pre-fix trimmed binding", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "owned-binding-spaces-"))
  );
  const mainPath = path.join(root, "notes "),
    importedPath = path.join(root, "notes");
  try {
    await owners(mainPath, "main-owner");
    await owners(importedPath, "trimmed-owner");
    const resolved = await resolvePath(mainPath, async () => "", {
      git: false,
    });
    expect(resolved.exists).toBe(true);
    expect(resolved.isDirectory).toBe(true);
    const agent = row(mainPath, null, null),
      store = new BindingStore(path.join(root, "state"));
    // A legacy record survives repeated import; new imports are fixed in #1613.
    await store.import([
      {
        session: agent.id,
        path: importedPath,
        currentPath: null,
        worktree: null,
      },
    ]);
    await store.import([bindingFromRow(agent)]);
    expect((await store.get(agent.id))?.checkout.path).toBe(importedPath);
    expect(evidence(await loadCodeowners(agent.cwd!))).toEqual({
      "main-owner": 1,
    });
    expect(evidence(await bindingRead(store))).toEqual({ "trimmed-owner": 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
