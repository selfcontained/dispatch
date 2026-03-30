import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "started", stderr: "" }))
}));

const { loadRepoTools, loadRepoHooks } = await import("../src/mcp/repo-tools.js");
const { runCommand } = await import("../src/lib/run-command.js");

const tempDirs: string[] = [];

const DEV_PARAMS = [
  { name: "cwd", type: "string", flag: "--cwd", description: "Working directory" },
  { name: "live", type: "boolean", flag: "--live", description: "Enable live mode" }
];

async function createToolsRepo(tools: unknown[], hooks?: unknown): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-repo-tools-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, ".dispatch"));
  const config: Record<string, unknown> = { tools };
  if (hooks !== undefined) config.hooks = hooks;
  await writeFile(path.join(repoRoot, ".dispatch", "tools.json"), JSON.stringify(config));
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.mocked(runCommand).mockClear();
  vi.mocked(runCommand).mockResolvedValue({ exitCode: 0, stdout: "started", stderr: "" });
});

describe("loadRepoTools", () => {
  it("auto-prefixes repo tools with repo_ namespace", async () => {
    const repoRoot = await createToolsRepo([
      { name: "dev_up", description: "Start the repo dev stack.", command: ["dispatch-dev", "up"] }
    ]);

    const [tool] = await loadRepoTools(repoRoot);
    const result = await tool.run({ agentId: "agt_test", repoRoot });

    expect(tool.name).toBe("repo_dev_up");
    expect(result.agentId).toBe("agt_test");
    expect(vi.mocked(runCommand)).toHaveBeenCalledWith("dispatch-dev", ["up"], expect.objectContaining({
      cwd: repoRoot,
      env: expect.objectContaining({
        DISPATCH_AGENT_ID: "agt_test",
        HOSTESS_AGENT_ID: "agt_test"
      })
    }));
  });

  it("appends CLI flags from params when provided", async () => {
    const repoRoot = await createToolsRepo([
      { name: "dev_up", description: "Start the repo dev stack.", command: ["dispatch-dev", "up"], params: DEV_PARAMS }
    ]);

    const [tool] = await loadRepoTools(repoRoot);
    expect(tool.params).toHaveLength(2);

    await tool.run({ agentId: "agt_test", repoRoot, params: { cwd: "/tmp/wt", live: true } });
    expect(vi.mocked(runCommand)).toHaveBeenCalledWith(
      "dispatch-dev",
      ["up", "--cwd", "/tmp/wt", "--live"],
      expect.objectContaining({ cwd: repoRoot })
    );
  });

  it("skips unset or false params", async () => {
    const repoRoot = await createToolsRepo([
      { name: "dev_up", description: "Start the repo dev stack.", command: ["dispatch-dev", "up"], params: DEV_PARAMS }
    ]);

    const [tool] = await loadRepoTools(repoRoot);

    await tool.run({ agentId: "agt_test", repoRoot, params: { live: false } });
    expect(vi.mocked(runCommand)).toHaveBeenCalledWith(
      "dispatch-dev",
      ["up"],
      expect.objectContaining({ cwd: repoRoot })
    );
  });

  it("sanitizes dots in repo tool names to underscores", async () => {
    const repoRoot = await createToolsRepo([
      { name: "project.dev_up", description: "Start the repo dev stack.", command: ["dispatch-dev", "up"] }
    ]);

    const [tool] = await loadRepoTools(repoRoot);
    expect(tool.name).toBe("repo_project_dev_up");
  });
});

describe("loadRepoHooks", () => {
  it("loads a stop hook from tools.json", async () => {
    const repoRoot = await createToolsRepo([], {
      stop: { command: ["./bin/dispatch-dev", "down"] }
    });

    const hooks = await loadRepoHooks(repoRoot);
    expect(hooks.stop).toEqual({ command: ["./bin/dispatch-dev", "down"] });
  });

  it("returns empty object when no hooks are defined", async () => {
    const repoRoot = await createToolsRepo([]);

    const hooks = await loadRepoHooks(repoRoot);
    expect(hooks).toEqual({});
  });

  it("returns empty object when tools.json does not exist", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-repo-tools-"));
    tempDirs.push(repoRoot);

    const hooks = await loadRepoHooks(repoRoot);
    expect(hooks).toEqual({});
  });

  it("throws on hook with empty command", async () => {
    const repoRoot = await createToolsRepo([], {
      stop: { command: [] }
    });

    await expect(loadRepoHooks(repoRoot)).rejects.toThrow('Hook "stop" must include a non-empty command array');
  });
});
