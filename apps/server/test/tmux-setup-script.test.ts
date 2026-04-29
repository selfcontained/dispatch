import { describe, it, expect } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  generateSetupScript,
  type SetupScriptParams,
} from "../src/agents/tmux/setup-script.js";

const baseConfig: AppConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  mediaRoot: "/tmp/dispatch-test-media",
  dispatchBinDir: "/usr/local/bin/dispatch",
  codexBin: "/opt/codex",
  claudeBin: "/opt/claude",
  opencodeBin: "/opt/opencode",
  agentRuntime: "inert",
  sessionPrefix: "dispatch",
  tls: null,
};

const baseParams: SetupScriptParams = {
  agentId: "agt_abc123def456",
  agentType: "claude",
  originalCwd: "/Users/me/proj",
  useWorktree: false,
  createNewBranch: true,
  agentName: "my-task",
  agentCommand: "exec /opt/claude",
  exitFile: "/tmp/dispatch_session.exit",
};

describe("generateSetupScript — script shape", () => {
  it("starts with a bash shebang and 'set -euo pipefail'", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    const firstLines = script.split("\n").slice(0, 2);
    expect(firstLines[0]).toBe("#!/usr/bin/env bash");
    expect(firstLines[1]).toBe("set -euo pipefail");
  });

  it("ends with `exec bash -c ...` so tmux-pane PID becomes the agent CLI", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).toMatch(/exec bash -c '[^']/);
    expect(script).toContain('echo "EXIT:$?"');
    expect(script).toContain(baseParams.exitFile);
  });

  it("interpolates the agent's setup-log path so the server can tail stderr", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).toContain(
      `tee "/tmp/dispatch_setup_${baseParams.agentId}.log"`
    );
  });
});

describe("generateSetupScript — worktree creation branch", () => {
  it("emits NO worktree commands when useWorktree=false", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).not.toContain("git worktree add");
    expect(script).not.toContain("Creating git worktree");
  });

  it("emits `worktree add -b <branch>` when createNewBranch=true", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).toContain('worktree add -b "my-branch"');
    expect(script).toContain("Creating git worktree");
    expect(script).toContain("Branch: my-branch");
  });

  it("emits `worktree add` (no -b) when createNewBranch=false", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: false,
      worktreeBranchName: "main",
      baseBranch: "main",
    });
    expect(script).toContain('worktree add "$WT_PATH" "main"');
    expect(script).toContain("Creating managed git worktree");
    expect(script).toContain("Checking out: main");
    // No `-b` flag
    expect(script).not.toContain("worktree add -b");
  });

  it("uses the provided worktreePathOverride literally", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
      worktreePathOverride: "/tmp/explicit-path",
    });
    expect(script).toContain('WT_PATH="/tmp/explicit-path"');
    // The default sibling-path computation should not appear when an
    // override is supplied.
    expect(script).not.toContain("REPO_BASENAME=");
  });

  it("computes a sibling worktree path when no override is given", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).toContain("REPO_BASENAME=");
    expect(script).toContain('WT_PATH="$(dirname "$REPO_ROOT")/');
  });

  it("rejects unsafe ref names (defense in depth even though createAgent already validated)", () => {
    expect(() =>
      generateSetupScript(baseConfig, {
        ...baseParams,
        useWorktree: true,
        createNewBranch: true,
        // Embedded shell metacharacter; assertSafeRefName must reject this.
        worktreeBranchName: "evil; rm -rf /",
      })
    ).toThrow();
  });
});

describe("generateSetupScript — type-specific blocks", () => {
  it("for opencode, emits the opencode.json MCP-config block", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      agentType: "opencode",
    });
    expect(script).toContain("Configure opencode MCP");
    expect(script).toContain("opencode.json");
    expect(script).toContain("MCP_ENTRY=");
  });

  it("for non-opencode agents, does NOT emit the opencode MCP block", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).not.toContain("Configure opencode MCP");
    expect(script).not.toContain("opencode.json");
  });

  it("for terminal agents in a worktree, skips the deps install block", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      agentType: "terminal",
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).not.toContain("Installing dependencies");
    // Worktree creation + .env copy should still happen.
    expect(script).toContain("Copying environment files");
  });

  it("for non-terminal agents in a worktree, emits the deps install block", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      agentType: "claude",
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).toContain("Installing dependencies");
    expect(script).toContain("pnpm-lock.yaml");
    expect(script).toContain("yarn.lock");
    expect(script).toContain("package-lock.json");
    expect(script).toContain("bun.lockb");
  });
});

describe("generateSetupScript — server callbacks", () => {
  it("phones home with the agent's auth token in the Authorization header", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).toContain("Authorization: Bearer test-token");
  });

  it("pushes phase transitions to /api/v1/agents/<id>/setup/phase", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).toContain(
      `/api/v1/agents/${baseParams.agentId}/setup/phase`
    );
    expect(script).toContain('"phase":"session"');
  });

  it("pushes the completion callback to /api/v1/agents/<id>/setup/complete", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).toContain(
      `/api/v1/agents/${baseParams.agentId}/setup/complete`
    );
  });

  it("on worktree-add failure, pushes the error message to /setup/error and exits", () => {
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).toContain(
      `/api/v1/agents/${baseParams.agentId}/setup/error`
    );
    expect(script).toContain("SETUP_ERROR_MSG=");
    expect(script).toContain("exit 1");
  });
});
