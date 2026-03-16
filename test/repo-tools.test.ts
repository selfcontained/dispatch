import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "started", stderr: "" }))
}));

const { loadRepoTools } = await import("../src/mcp/repo-tools.js");
const { runCommand } = await import("../src/lib/run-command.js");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.mocked(runCommand).mockClear();
  vi.mocked(runCommand).mockResolvedValue({ exitCode: 0, stdout: "started", stderr: "" });
});

describe("loadRepoTools", () => {
  it("auto-prefixes repo tools with repo. namespace", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-repo-tools-"));
    tempDirs.push(repoRoot);
    await mkdir(path.join(repoRoot, ".dispatch"));
    await writeFile(
      path.join(repoRoot, ".dispatch", "tools.json"),
      JSON.stringify({
        tools: [
          {
            name: "dev_up",
            description: "Start the repo dev stack.",
            command: ["dispatch-dev", "up"]
          }
        ]
      })
    );

    const [tool] = await loadRepoTools(repoRoot);
    const result = await tool.run({ agentId: "agt_test", repoRoot });

    expect(tool.name).toBe("repo.dev_up");
    expect(result.agentId).toBe("agt_test");
    expect(vi.mocked(runCommand)).toHaveBeenCalledWith("dispatch-dev", ["up"], expect.objectContaining({
      cwd: repoRoot,
      env: expect.objectContaining({
        DISPATCH_AGENT_ID: "agt_test",
        HOSTESS_AGENT_ID: "agt_test"
      })
    }));
  });

  it("rejects repo tools whose names contain dots", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-repo-tools-"));
    tempDirs.push(repoRoot);
    await mkdir(path.join(repoRoot, ".dispatch"));
    await writeFile(
      path.join(repoRoot, ".dispatch", "tools.json"),
      JSON.stringify({
        tools: [
          {
            name: "project.dev_up",
            description: "Start the repo dev stack.",
            command: ["dispatch-dev", "up"]
          }
        ]
      })
    );

    await expect(loadRepoTools(repoRoot)).rejects.toThrow("must not contain dots");
  });
});
