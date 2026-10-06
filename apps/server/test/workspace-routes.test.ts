import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgentWorkspaceRoutes } from "../src/routes/agents/workspace-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

describe("workspace browsing", () => {
  let root: string;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dispatch-files-test-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".git"));
    await writeFile(
      path.join(root, "src", "hello.ts"),
      "export const hello = 1;\n"
    );
    app = Fastify();
    await registerAgentWorkspaceRoutes(app, {
      agentManager: {
        getAgent: async (id: string) =>
          id === "missing"
            ? null
            : {
                cwd: "/not-the-workspace",
                workspacePath: root,
                worktreePath: null,
              },
      } as unknown as AgentRouteDeps["agentManager"],
    });
  });
  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const get = (relative = "", file = false, workspace?: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/agents/test/workspace?${new URLSearchParams({ path: relative, file: String(file), workspace: workspace ?? root })}`,
    });
  it("uses the effective workspace and lists one level without Git internals", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      entries: [{ name: "src", path: "src", kind: "directory" }],
      truncated: false,
    });
    expect((await get("src/hello.ts", true)).json().text).toContain(
      "export const hello"
    );
  });
  it("hides Git-ignored folders and files while retaining negations and tracked files", async () => {
    await promisify(execFile)("git", ["init", root]);
    await writeFile(
      path.join(root, ".gitignore"),
      "node_modules/\n*.log\n!keep.log\n"
    );
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "hidden.log"), "hidden");
    await writeFile(path.join(root, "keep.log"), "visible");
    await writeFile(path.join(root, "tracked.log"), "tracked");
    await promisify(execFile)("git", ["-C", root, "add", "-f", "tracked.log"]);
    const response = await get();
    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .entries.map((entry: { name: string }) => entry.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("hidden.log");
    expect(names).toContain("keep.log");
    expect(names).toContain("tracked.log");
  });
  it("ignored entries do not consume the 500 visible-entry budget", async () => {
    await promisify(execFile)("git", ["init", root]);
    await writeFile(path.join(root, ".gitignore"), "*.ignored\n");
    await Promise.all(
      Array.from({ length: 620 }, (_, i) =>
        writeFile(path.join(root, `entry-${i}.ignored`), "")
      )
    );
    await Promise.all(
      Array.from({ length: 480 }, (_, i) =>
        writeFile(path.join(root, `visible-${i}.txt`), "")
      )
    );
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toHaveLength(482);
    expect(response.json().truncated).toBe(false);
    expect(
      response
        .json()
        .entries.every(
          (entry: { name: string }) => !entry.name.endsWith(".ignored")
        )
    ).toBe(true);
  });
  it.each([".GIT", ".Git"])(
    "rejects Git internals aliases %s for listing and preview",
    async (alias) => {
      await writeFile(path.join(root, ".git", "PRIVATE"), "private");
      expect((await get(alias)).statusCode).toBe(400);
      const result = await get(alias + "/PRIVATE", true);
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain("private");
    }
  );
  it("browses submodules with their own ignore rules", async () => {
    await promisify(execFile)("git", ["init", root]);
    const sub = path.join(root, "sub");
    await mkdir(sub);
    await promisify(execFile)("git", ["init", sub]);
    await writeFile(path.join(sub, "hello.txt"), "hello");
    await writeFile(path.join(sub, "ignored.log"), "hidden");
    await writeFile(path.join(sub, ".gitignore"), "*.log\n");
    await promisify(execFile)("git", [
      "-C",
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,1111111111111111111111111111111111111111,sub",
    ]);
    const result = await get("sub");
    expect(result.statusCode).toBe(200);
    const names = result
      .json()
      .entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain("hello.txt");
    expect(names).not.toContain("ignored.log");
    expect(names).not.toContain(".git");
  });
  it.each([
    "../outside",
    "/etc/passwd",
    "src/../../outside",
    ".git/config",
    "src\\hello.ts",
  ])("rejects unsafe path %s", async (relative) => {
    expect((await get(relative, true)).statusCode).toBe(400);
  });
  it("does not follow file or directory symlinks", async () => {
    await symlink(path.join(root, "src"), path.join(root, "linked"));
    await symlink(
      path.join(root, "src/hello.ts"),
      path.join(root, "linked.ts")
    );
    expect((await get("linked")).statusCode).toBe(403);
    expect((await get("linked/hello.ts", true)).statusCode).toBe(403);
    expect((await get("linked.ts", true)).statusCode).toBe(403);
  });
  it("bounds file reads and distinguishes binary from empty text", async () => {
    await writeFile(path.join(root, "large"), Buffer.alloc(1_048_577, 65));
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "empty"), "");
    expect((await get("large", true)).json().kind).toBe("unsupported");
    expect((await get("binary", true)).json().kind).toBe("unsupported");
    expect((await get("empty", true)).json()).toEqual({
      kind: "text",
      text: "",
      size: 0,
    });
  });
  it("reports stale workspaces and removed files", async () => {
    expect((await get("", false, "/old/workspace")).statusCode).toBe(409);
    expect((await get("removed", true)).statusCode).toBe(404);
  });
  it("bounds directory enumeration and marks incomplete results", async () => {
    await Promise.all(
      Array.from({ length: 510 }, (_, i) =>
        writeFile(path.join(root, `file-${i}`), "")
      )
    );
    const data = (await get()).json();
    expect(data.entries).toHaveLength(500);
    expect(data.truncated).toBe(true);
  });
});
