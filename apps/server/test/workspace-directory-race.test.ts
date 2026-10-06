import { afterEach, expect, test, vi } from "vitest";
import Fastify from "fastify";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  symlink,
  rm,
  realpath,
  opendir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { registerAgentWorkspaceRoutes } from "../src/routes/agents/workspace-routes.js";
import { buildWorkspaceFileIndex } from "../src/files/workspace-file-index.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(opendir).mockReset();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises"
    );
  vi.mocked(opendir).mockImplementation(actual.opendir);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "workspace-race-"))
  );
  roots.push(base);
  const root = path.join(base, "workspace"),
    folder = path.join(root, "folder"),
    outside = path.join(base, "outside");
  await mkdir(folder, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "private-outside-name.txt"), "private");
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises"
    );
  vi.mocked(opendir).mockImplementation(async (...args) => {
    if (String(args[0]) === folder) {
      await rename(folder, path.join(base, "original"));
      await symlink(outside, folder);
    }
    return actual.opendir(...args);
  });
  return { root };
}
test("directory route rejects replacement with an outside symlink before open", async () => {
  const { root } = await fixture();
  const app = Fastify();
  try {
    await registerAgentWorkspaceRoutes(app, {
      agentManager: {
        getAgent: async () => ({
          cwd: root,
          workspacePath: null,
          worktreePath: null,
        }),
      } as unknown as AgentRouteDeps["agentManager"],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/agents/test/workspace?${new URLSearchParams({ workspace: root, path: "folder" })}`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("private-outside-name");
  } finally {
    await app.close();
  }
});
test("non-Git index discards a directory replaced before open", async () => {
  const { root } = await fixture();
  const result = await buildWorkspaceFileIndex(root);
  expect(result.source).toBe("folders");
  expect(result.truncated).toBe(true);
  expect(result.paths).not.toContain("folder/private-outside-name.txt");
});
