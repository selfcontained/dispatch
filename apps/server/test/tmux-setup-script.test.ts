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
};

describe("generateSetupScript — script shape", () => {
  it("starts with a bash shebang and 'set -euo pipefail'", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    const firstLines = script.split("\n").slice(0, 2);
    expect(firstLines[0]).toBe("#!/usr/bin/env bash");
    expect(firstLines[1]).toBe("set -euo pipefail");
  });

  it("ends with `exec bash -c '<agentCommand>'` so tmux-pane PID becomes the agent CLI", () => {
    const script = generateSetupScript(baseConfig, baseParams);
    expect(script).toMatch(/exec bash -c '[^']/);
  });

  it("does NOT bake in stderr tee or exit-code capture — the runtime wrapper owns those", () => {
    // Phase 5 round-2 cleanup: the script is no longer responsible for
    // its own log path or exit-file convention. The runtime applies an
    // outer wrap (stderr tee + exit capture) around `bash <scriptPath>`,
    // so these conventions live in exactly one place.
    const script = generateSetupScript(baseConfig, baseParams);
    // The script no longer redirects its own stderr — anchor on the
    // shell construct, not the word "tee" (which still appears in the
    // explanatory comment that points readers at the runtime).
    expect(script).not.toMatch(/exec 2>\s*>\(tee/);
    expect(script).not.toContain('echo "EXIT:$?"');
    expect(script).not.toMatch(/\.exit['"]?\s*$/m);
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

  it("captures the worktree-add exit code explicitly so `set -e` cannot abort before the error handler (issue #682)", () => {
    // Regression: under `set -euo pipefail`, a `VAR=$(cmd)` assignment whose
    // command substitution fails terminates the script immediately — so the
    // `if [ $? -eq 0 ]; else … /setup/error … fi` block is dead code and the
    // failure (e.g. a non-zero post-checkout git hook) is silently swallowed.
    // The fix must disable errexit around the assignment and capture the
    // status into a variable that the success check reads.
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    const lines = script.split("\n");
    const addIdx = lines.findIndex((l) => l.includes("WORKTREE_ADD_OUTPUT=$("));
    expect(addIdx).toBeGreaterThan(-1);

    // errexit is disabled immediately before the capture and restored after.
    const before = lines.slice(Math.max(0, addIdx - 2), addIdx);
    expect(before.some((l) => l.trim() === "set +e")).toBe(true);

    // The return code is captured into a variable on the line right after the
    // assignment, and errexit is restored.
    const after = lines.slice(addIdx + 1, addIdx + 4);
    expect(after.some((l) => /^\s*WT_RC=\$\?\s*$/.test(l))).toBe(true);
    expect(after.some((l) => l.trim() === "set -euo pipefail")).toBe(true);

    // The success check must read the captured code, NOT `$?` (which would be
    // clobbered by the intervening `set` command).
    expect(script).toContain('if [ "$WT_RC" -eq 0 ]; then');
    expect(script).not.toContain("if [ $? -eq 0 ]; then");
  });

  it("sanitizes the worktree-add error for a valid JSON body — strips ALL C0 control chars, not just CR/LF (issue #682)", () => {
    // The hook stderr that lands in WORKTREE_ADD_OUTPUT (e.g. a Git LFS
    // post-checkout hook) routinely contains tabs (0x09) and ANSI escapes
    // (0x1b). JSON forbids unescaped control chars (U+0000–U+001F), so a body
    // containing them is rejected by the server's JSON.parse — and because the
    // setup/error curl ends in `|| true`, that 400 is swallowed and last_error
    // stays empty for exactly the failure this fix exists to surface. Strip
    // the whole C0 range, and guard against a byte-truncated multi-byte UTF-8
    // codepoint so the body stays valid.
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    // Strips the entire C0 control range, not just \n and \r.
    expect(script).toContain("tr -d '\\000-\\037'");
    expect(script).not.toContain('tr -d "\\n\\r"');
    // Drops any severed trailing UTF-8 codepoint after the byte cap.
    expect(script).toContain("iconv -f utf-8 -t utf-8 -c");
  });

  it("bounds the error message with a bash slice, not `head -c`, so huge hook output can't SIGPIPE the pipeline under pipefail (issue #682)", () => {
    // `printf … | head -c 800` makes `head` close the pipe early once it has
    // its 800 bytes; on output larger than the pipe buffer `printf` takes
    // SIGPIPE and, with `pipefail` + `errexit`, the `VAR=$(…)` assignment
    // aborts the script before the error is ever reported — the exact silent
    // death #682 fixes, just at a higher output threshold. A bash substring
    // bounds the size with no pipe at all.
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).toContain("${WORKTREE_ADD_OUTPUT:0:800}");
    expect(script).not.toContain("head -c 800");
  });

  it("rolls back the partial worktree (and the just-created branch) on failure so relaunch starts clean (issue #682)", () => {
    // `git worktree add` can leave the worktree dir and, for createNewBranch,
    // the new branch on disk even when it exits non-zero (hook failure). With
    // the failure path now live, a relaunch reuses the same deterministic
    // WT_PATH and `-b <branch>` and would fail with "already exists", masking
    // the real error. Clean up best-effort before exiting.
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranchName: "my-branch",
    });
    expect(script).toContain(
      'git -C "$REPO_ROOT" worktree remove --force "$WT_PATH" 2>/dev/null || true'
    );
    // The new branch is git's to delete only because this run just created it.
    expect(script).toContain(
      'git -C "$REPO_ROOT" branch -D "my-branch" 2>/dev/null || true'
    );
  });

  it("does NOT delete the branch on cleanup when checking out an existing branch (createNewBranch=false)", () => {
    // With createNewBranch=false the branch pre-existed — deleting it would be
    // destructive. Only the worktree dir should be rolled back.
    const script = generateSetupScript(baseConfig, {
      ...baseParams,
      useWorktree: true,
      createNewBranch: false,
      worktreeBranchName: "main",
      baseBranch: "main",
    });
    expect(script).toContain(
      'git -C "$REPO_ROOT" worktree remove --force "$WT_PATH" 2>/dev/null || true'
    );
    expect(script).not.toContain("branch -D");
  });
});
