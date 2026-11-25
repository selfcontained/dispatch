/*
 * T34 pins: the exact bytes of every local repository key Dispatch stores
 * Brain memory, task scope and loop handoffs under. Brain memory and task
 * boards are found by these bytes alone, so a one-byte change orphans them
 * silently. These cases were recorded on the code before T34 and checked
 * against origin/main; they must stay unmodified.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../src/agents/manager.js";
import { inspectAgentCheckout } from "../src/agents/checkout-runner.js";
import { JobService } from "../src/jobs/service.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { resolveRepoRoot } from "../src/shared/git/git-context.js";
import { agentTaskProject } from "./helpers/task-scope.js";

let tmp: string;
let root: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

beforeAll(() => {
  // `tmp` is the spelling the OS hands out (a symlink on macOS); `root`
  // is its physical path.
  tmp = mkdtempSync(join(tmpdir(), "dispatch-identity-"));
  root = realpathSync(tmp);
  mkdirSync(join(root, "repo/a/b"), { recursive: true });
  git(root, "init", "-q", "-b", "main", "repo");
  git(join(root, "repo"), "commit", "-q", "--allow-empty", "-m", "init");
  git(join(root, "repo"), "worktree", "add", "-q", "-b", "wt", "../wt");
  mkdirSync(join(root, "plain/inner"), { recursive: true });
  symlinkSync(join(root, "repo"), join(root, "link"));
  symlinkSync(join(root, "plain"), join(root, "plainlink"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The workspace a local agent's tools run in (routes/mcp.ts). */
function localAgent(cwd: string, extra: Partial<AgentRecord> = {}) {
  return {
    id: "agt_pin",
    cwd,
    workspacePath: null,
    worktreePath: null,
    placement: controllerPlacement,
    projectId: null,
    ...extra,
  } as unknown as AgentRecord;
}

const cases: Array<[string, () => string, () => string | null]> = [
  ["repository root", () => join(root, "repo"), () => join(root, "repo")],
  ["subdirectory", () => join(root, "repo/a/b"), () => join(root, "repo")],
  ["linked worktree", () => join(root, "wt"), () => join(root, "repo")],
  ["non-Git folder", () => join(root, "plain/inner"), () => null],
  [
    "path through a symlink",
    () => join(root, "link/a"),
    () => join(root, "repo"),
  ],
  ["trailing slash", () => join(root, "repo") + "/", () => join(root, "repo")],
  [
    "temp path as the OS spells it",
    () => join(tmp, "repo/a"),
    () => join(root, "repo"),
  ],
];

describe("local repository key pins", () => {
  // Brain, list_agents and PR risk: the MCP routes' repository root.
  it.each(cases)("MCP repository root: %s", async (_name, input, expected) => {
    const reply = await inspectAgentCheckout(localAgent(input()), {
      kind: "roots",
    });
    expect(reply).toMatchObject({ kind: "roots" });
    expect(reply.kind === "roots" ? reply.repositoryRoot : undefined).toBe(
      expected()
    );
  });

  // Another agent's key in the agent list, and task scope for no project.
  it.each(cases)("resolveRepoRoot: %s", async (_name, input, expected) => {
    const key = await resolveRepoRoot(input()).catch(() => null);
    expect(key).toBe(expected());
  });

  it("the MCP routes read a moved workspace before the launch folder", async () => {
    const reply = await inspectAgentCheckout(
      localAgent(join(root, "plain"), {
        workspacePath: join(root, "wt"),
        worktreePath: join(root, "plain"),
      }),
      { kind: "roots" }
    );
    expect(reply).toEqual({
      kind: "roots",
      repositoryRoot: join(root, "repo"),
      checkoutRoot: join(root, "wt"),
    });
  });

  it("task scope for an agent with no project: repository, then workspace", async () => {
    const seen: unknown[] = [];
    const scope = async (input: unknown) => {
      seen.push(input);
      return null;
    };
    await agentTaskProject(localAgent(join(root, "repo/a")), scope);
    await agentTaskProject(localAgent(join(root, "plain/inner")), scope);
    await agentTaskProject(localAgent(join(root, "link/a") + "/"), scope);
    expect(seen).toEqual([
      { projectId: null, paths: [join(root, "repo"), join(root, "repo/a")] },
      { projectId: null, paths: [null, join(root, "plain/inner")] },
      {
        projectId: null,
        paths: [join(root, "repo"), join(root, "link/a") + "/"],
      },
    ]);
  });

  it("task scope for an agent with a project is the project", async () => {
    const scope = vi.fn();
    expect(
      await agentTaskProject(
        localAgent(join(root, "plain"), { projectId: "prj_1" }),
        scope
      )
    ).toBe("prj_1");
    expect(scope).not.toHaveBeenCalled();
  });
});

describe("loop handoff key pins (jobs)", () => {
  async function handoffKey(directory: string) {
    const keys: string[] = [];
    const brain = {
      getObject: async (repoRoot: string) => {
        keys.push(repoRoot);
        return null;
      },
      storeObject: async () => ({}),
    };
    const service = new JobService(
      {} as never,
      {} as never,
      { warn() {}, info() {}, error() {} } as never,
      {} as never,
      brain as never
    );
    (service as unknown as { store: unknown }).store = {
      getJob: async () => ({ id: "job_1", continuationEnabled: true }),
    };
    await (
      service as unknown as {
        syncContinuationHandoff(run: unknown): Promise<void>;
      }
    ).syncContinuationHandoff({
      id: "run_1",
      jobId: "job_1",
      agentId: "agt_pin",
      chainId: null,
      chainIteration: 1,
      config: { directory },
    });
    return keys[0];
  }

  it.each([
    ["repository root", () => join(root, "repo"), () => join(root, "repo")],
    ["subdirectory", () => join(root, "repo/a/b"), () => join(root, "repo")],
    ["linked worktree", () => join(root, "wt"), () => join(root, "repo")],
    [
      "non-Git folder",
      () => join(root, "plain/inner"),
      () => join(root, "plain/inner"),
    ],
    [
      "non-Git folder with a trailing slash",
      () => join(root, "plain") + "//",
      () => join(root, "plain"),
    ],
    [
      "non-Git folder through a symlink",
      () => join(root, "plainlink"),
      () => join(root, "plainlink"),
    ],
    [
      "repository through a symlink",
      () => join(root, "link"),
      () => join(root, "repo"),
    ],
    [
      "trailing slash",
      () => join(root, "repo") + "/",
      () => join(root, "repo"),
    ],
  ])("%s", async (_name, input, expected) => {
    expect(await handoffKey(input())).toBe(expected());
  });
});

it("keeps main's worktree repository key when a partial task record has no launch cwd", async () => {
  const workspace = join(root, "wt");
  expect(await resolveRepoRoot(workspace)).toBe(join(root, "repo"));
  const scope = vi.fn(async () => null);
  await agentTaskProject(
    {
      id: "agt_partial_scope",
      cwd: null,
      worktreePath: null,
      workspacePath: workspace,
      baseBranch: null,
      placement: controllerPlacement,
    },
    scope
  );
  expect(scope).toHaveBeenCalledExactlyOnceWith({
    projectId: null,
    paths: [join(root, "repo"), workspace],
  });
});
