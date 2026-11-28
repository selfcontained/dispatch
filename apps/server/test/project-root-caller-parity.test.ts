import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { resolveProjectRoot as nativeProjectRoot } from "../../../packages/runner/src/workload/projects/resolve-root.js";
import {
  registerProjectRoutes,
  resolveProjectRoot,
} from "../src/routes/projects.js";
import { workspaceWorkload } from "../../../packages/runner/src/workload/agents/checkout-worker.js";
import { launchDirectory } from "../src/agents/workspace-launch.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "project-root-caller-"))
  );
  roots.push(root);
  await mkdir(path.join(root, "plain"));
  await mkdir(path.join(root, "repo"));
  await writeFile(path.join(root, "file"), "file");
  execFileSync("git", ["init", "--quiet", path.join(root, "repo")]);
  return root;
}
it.each(["missing", "relative-missing", "file", "git-error"] as const)(
  "pins project HTTP status/body and exact helper error for %s",
  async (kind) => {
    const root = await fixture();
    const input =
      kind === "relative-missing"
        ? path.relative(process.cwd(), path.join(root, "missing"))
        : path.join(root, kind === "git-error" ? "repo" : kind);
    if (kind === "git-error")
      vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
    const failure = await nativeProjectRoot(input).catch(
      (error: Error) => error
    );
    expect(failure).toBeInstanceOf(Error);
    const routedFailure = await resolveProjectRoot(input).catch(
      (error: Error) => error
    );
    expect((routedFailure as Error).message).toBe((failure as Error).message);
    const query = vi.fn(async () => ({ rows: [] }));
    const publishUiEvent = vi.fn();
    const app = Fastify();
    try {
      await registerProjectRoutes(app, {
        pool: { query } as unknown as Pool,
        publishUiEvent,
        taskService: {
          taskIdsForProject: vi.fn(),
          cleanupProjectAttachments: vi.fn(),
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "Project", color: "#112233", repoRoot: input },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe('{"error":"Choose an existing folder."}');
      expect(query).not.toHaveBeenCalled();
      expect(publishUiEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
it("pins main's accepted relative project root and complete HTTP body", async () => {
  const root = await fixture();
  const folder = path.join(root, "plain");
  const input = path.relative(process.cwd(), folder);
  expect(await resolveProjectRoot(input)).toBe(folder);
  const row = {
    id: "fixture-project",
    name: "Project",
    repoRoot: folder,
    extraRoots: [],
    color: "#112233",
    iconOverride: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("INSERT INTO projects")) {
      expect(params?.[2]).toBe(folder);
      return { rows: [row] };
    }
    return { rows: [] };
  });
  const publishUiEvent = vi.fn();
  const app = Fastify();
  try {
    await registerProjectRoutes(app, {
      pool: { query } as unknown as Pool,
      publishUiEvent,
      taskService: {
        taskIdsForProject: vi.fn(),
        cleanupProjectAttachments: vi.fn(),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Project", color: "#112233", repoRoot: input },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify(row));
    expect(publishUiEvent).toHaveBeenCalledExactlyOnceWith({
      type: "project.changed",
    });
  } finally {
    await app.close();
  }
});
it.each(["missing", "relative", "file"] as const)(
  "keeps the launch guard's main response before using project fields: %s",
  async (kind) => {
    const root = await fixture();
    const input =
      kind === "relative"
        ? path.relative(process.cwd(), path.join(root, "plain"))
        : path.join(root, kind);
    const answer = await workspaceWorkload.resolvePath(input, {
      projectRoot: true,
      git: false,
    });
    // Manager.resolveCreateTarget invokes this guard before looking at either
    // projectRoot field, so enriching those fields cannot accept an invalid path.
    expect({
      exists: answer.exists,
      isDirectory: answer.isDirectory,
      canonicalPath: answer.canonicalPath,
      resolvedPath: answer.resolvedPath,
    }).toEqual({
      exists: kind === "file",
      isDirectory: false,
      canonicalPath: null,
      resolvedPath: input,
    });
    expect(() => launchDirectory(answer)).toThrow(
      kind === "relative"
        ? "Working directory must be an absolute path."
        : "Working directory does not exist or is not a directory."
    );
  }
);
