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

import {
  projectRepositoryUrl,
  repositoryUrl,
} from "../src/agents/remote/repository.js";
import { JobService } from "../src/jobs/service.js";
import { resolveProjectRoot } from "../src/projects/resolve-root.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import {
  identityKey,
  projectIdentities,
  projectKey,
  repositoryKey,
  SESSION_REPOSITORY_SQL,
} from "../src/runners/repository-identity.js";
import { resolveRepoRoot } from "../src/shared/git/git-context.js";

const runner = placementForRunner("rnr_identity");

describe("repository identity (D5, D8)", () => {
  it("a controller root is its own key; another runner's root is not a key", () => {
    expect(identityKey(controllerPlacement, "/srv/repo")).toBe("/srv/repo");
    expect(identityKey(controllerPlacement, null)).toBeNull();
    expect(identityKey(runner, "/home/runner/repo")).toBeNull();
  });

  it("a controller session reads its root and never its project", async () => {
    const project = vi.fn();
    await expect(
      repositoryKey({
        placement: controllerPlacement,
        repositoryRoot: async () => "/srv/repo",
        project,
      })
    ).resolves.toBe("/srv/repo");
    // A local folder with no repository has no key, even in a project (main).
    await expect(
      repositoryKey({
        placement: controllerPlacement,
        repositoryRoot: async () => null,
        project,
      })
    ).resolves.toBeNull();
    expect(project).not.toHaveBeenCalled();
  });

  it("a runner session takes its project's key and never reads its own root", async () => {
    const repositoryRoot = vi.fn();
    const key = (
      project: { repoRoot: string | null; repository: string | null } | null
    ) =>
      repositoryKey({
        placement: runner,
        repositoryRoot,
        project: async () => project,
      });
    await expect(
      key({ repoRoot: "/srv/repo", repository: "https://github.com/o/r" })
    ).resolves.toBe("/srv/repo");
    await expect(
      key({ repoRoot: null, repository: "https://github.com/o/r" })
    ).resolves.toBe("https://github.com/o/r");
    // No project and no recorded repository: no key, as a local non-Git folder.
    await expect(key(null)).resolves.toBeNull();
    expect(repositoryRoot).not.toHaveBeenCalled();
  });

  it("a runner session with no project takes its recorded repository (owner: option A)", async () => {
    const key = (
      project: { repoRoot: string | null; repository: string | null } | null,
      repository: string | null
    ) =>
      repositoryKey({
        placement: runner,
        repositoryRoot: vi.fn(),
        project: async () => project,
        repository: async () => repository,
      });
    // Stored by a launch as `repositoryUrl(url)`; keyed as a project stores it.
    await expect(
      key(null, repositoryUrl("https://github.com/Owner/Repo.git/"))
    ).resolves.toBe(projectRepositoryUrl("https://github.com/Owner/Repo"));
    await expect(key(null, null)).resolves.toBeNull();
    await expect(key(null, "not a url")).resolves.toBeNull();
    // A project wins over the recorded repository.
    await expect(
      key({ repoRoot: "/srv/repo", repository: null }, "https://github.com/o/r")
    ).resolves.toBe("/srv/repo");
  });

  it("shares one key, both ways, with a repository-only project's runner agents", async () => {
    const project = projectRepositoryUrl("https://github.com/Owner/Repo");
    const inProject = await repositoryKey({
      placement: runner,
      repositoryRoot: vi.fn(),
      project: async () => ({ repoRoot: null, repository: project }),
      repository: async () => "https://github.com/Owner/Repo",
    });
    for (const recorded of [
      "https://github.com/Owner/Repo",
      "https://github.com/Owner/Repo.git",
      "https://GitHub.com/Owner/Repo/",
    ]) {
      const projectless = await repositoryKey({
        placement: runner,
        repositoryRoot: vi.fn(),
        project: async () => null,
        repository: async () => repositoryUrl(recorded),
      });
      expect(projectless).toBe(inProject);
    }
  });

  it("a controller session never reads a recorded repository", async () => {
    const repository = vi.fn();
    await expect(
      repositoryKey({
        placement: controllerPlacement,
        repositoryRoot: async () => null,
        project: async () => null,
        repository,
      })
    ).resolves.toBeNull();
    expect(repository).not.toHaveBeenCalled();
  });

  it("project keys follow D8's order", () => {
    expect(projectKey(null)).toBeNull();
    expect(projectKey({ repoRoot: null, repository: null })).toBeNull();
    expect(projectKey({ repoRoot: "/a", repository: "https://x/y" })).toBe(
      "/a"
    );
  });

  it("reads each project once", async () => {
    const read = vi.fn(async (id: string) => ({
      repoRoot: id,
      repository: null,
    }));
    const project = projectIdentities(read);
    await project("p1");
    await project("p1");
    await project(null);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("a project's primary root is the key its local agents already use", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-identity-key-")));
    mkdirSync(join(root, "repo/a"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", join(root, "repo")]);
    execFileSync(
      "git",
      ["-C", join(root, "repo"), "commit", "-q", "--allow-empty", "-m", "i"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }
    );
    execFileSync("git", [
      "-C",
      join(root, "repo"),
      "worktree",
      "add",
      "-q",
      "-b",
      "wt",
      "../wt",
    ]);
    symlinkSync(join(root, "repo"), join(root, "link"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Projects store `resolveProjectRoot` of the folder they were made from; a
  // local agent anywhere in that checkout is keyed by `resolveRepoRoot`.
  it.each(["repo", "repo/a", "wt", "link", "link/a"])(
    "made from %s",
    async (folder) => {
      const stored = await resolveProjectRoot(join(root, folder));
      expect(stored).toBe(join(root, "repo"));
      expect(await resolveRepoRoot(join(root, folder))).toBe(stored);
    }
  );
});

describe("option A readiness: a session's repository key equals its project's", () => {
  // A project stores `projectRepositoryUrl(input)`; a runner launch stores
  // `repositoryUrl(url)` in `agents.runner_repository`. Option A would key a
  // project-less session by `projectRepositoryUrl` of that stored URL.
  it.each([
    "https://github.com/Owner/Repo",
    "https://github.com/Owner/Repo.git",
    "https://github.com/Owner/Repo/",
    "https://github.com/Owner/Repo.git/",
    "https://GitHub.com/Owner/Repo",
    "https://github.com:443/Owner/Repo",
    "https://git.example.com/group/sub/repo.git",
  ])("%s", (spelling) => {
    const project = projectRepositoryUrl(spelling);
    const session = projectRepositoryUrl(repositoryUrl(spelling));
    expect(session).toBe(project);
  });

  it("a URL with credentials is stored by neither", () => {
    const spelling = "https://user:token@github.com/Owner/Repo.git";
    expect(() => projectRepositoryUrl(spelling)).toThrow();
    expect(() => repositoryUrl(spelling)).toThrow();
  });

  it("an origin read from Git keys the same as the URL typed for the project", () => {
    expect(
      projectRepositoryUrl(repositoryUrl("git@github.com:Owner/Repo.git", true))
    ).toBe(projectRepositoryUrl("https://github.com/Owner/Repo"));
  });
});

describe("loop handoff on a runner", () => {
  async function handoffKey(
    project: { repoRoot: string | null; repository: string | null } | null,
    recorded: string | null = null
  ) {
    const keys: string[] = [];
    const service = new JobService(
      {
        query: async (sql: string) =>
          sql === SESSION_REPOSITORY_SQL
            ? { rows: [{ url: recorded }] }
            : { rows: project ? [project] : [] },
      } as never,
      {
        getAgent: async () => ({ id: "agt_r", projectId: project && "prj_r" }),
      } as never,
      { warn() {}, info() {}, error() {} } as never,
      {} as never,
      {
        getObject: async (key: string) => {
          keys.push(key);
          return null;
        },
        storeObject: async () => ({}),
      } as never
    );
    (service as unknown as { store: unknown }).store = {
      getJob: async () => ({ id: "job_r", continuationEnabled: true }),
    };
    await (
      service as unknown as {
        syncContinuationHandoff(run: unknown): Promise<void>;
      }
    ).syncContinuationHandoff({
      id: "run_r",
      jobId: "job_r",
      agentId: "agt_r",
      chainId: null,
      chainIteration: 1,
      config: { directory: "runner://rnr_identity/ws_1" },
    });
    return keys[0];
  }

  it("writes where the successor's Brain reads: the project's key", async () => {
    await expect(
      handoffKey({
        repoRoot: "/srv/repo",
        repository: "https://github.com/o/r",
      })
    ).resolves.toBe("/srv/repo");
    await expect(
      handoffKey({ repoRoot: null, repository: "https://github.com/o/r" })
    ).resolves.toBe("https://github.com/o/r");
  });

  it("a run with no project writes under its recorded repository", async () => {
    await expect(
      handoffKey(null, "https://github.com/Owner/Repo.git")
    ).resolves.toBe("https://github.com/Owner/Repo");
  });

  it("a run with no project and no repository keeps today's key", async () => {
    await expect(handoffKey(null)).resolves.toBe("runner://rnr_identity/ws_1");
  });
});
