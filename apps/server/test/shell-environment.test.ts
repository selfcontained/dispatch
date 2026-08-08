import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCapturedEnvironment,
  captureLegacyMacEnvironment,
  firstLaunchdProgramArgument,
  parseCapturedEnvironment,
  replaceProcessEnvironment,
  restoreLegacyMacLaunchAgentEnvironment,
  shouldRestoreLegacyMacEnvironment,
} from "../src/startup/shell-environment.js";
import { loadRepoTools } from "../src/shared/mcp/repo-tools.js";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-shell-env-"));
  tempDirs.push(dir);
  return dir;
}

async function fakeZsh(home: string): Promise<string> {
  const shell = path.join(home, "zsh");
  await writeFile(shell, '#!/bin/bash\nexec /bin/bash "$@"\n');
  await chmod(shell, 0o755);
  return shell;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("shell environment capture", () => {
  it("applies legacy zprofile/zshrc exports, overwrites, and unsets", async () => {
    const home = await tempHome();
    const shell = await fakeZsh(home);
    await writeFile(
      path.join(home, ".zprofile"),
      [
        `export PROFILE_ONLY='value with spaces=and-equals'`,
        `export COLLISION='zprofile'`,
        `unset REMOVED_BY_PROFILE`,
        `export PATH="$HOME/node bin:/usr/bin:/bin"`,
      ].join("\n")
    );
    await writeFile(path.join(home, ".zshrc"), `export COLLISION='zshrc'\n`);

    const result = await captureLegacyMacEnvironment({
      inheritedEnv: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        COLLISION: "service-value",
        REMOVED_BY_PROFILE: "remove-me",
      },
      macShellPath: shell,
      environmentEmitter: "/usr/bin/env -0",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.PROFILE_ONLY).toBe(
      "value with spaces=and-equals"
    );
    expect(result.environment.COLLISION).toBe("zshrc");
    expect(result.environment.REMOVED_BY_PROFILE).toBeUndefined();
    expect(result.environment.PATH).toBe(`${home}/node bin:/usr/bin:/bin`);
  });

  it("lets an MCP repo tool delegate to a Node-backed project command", async () => {
    const home = await tempHome();
    const shell = await fakeZsh(home);
    const repo = await tempHome();
    const runtime = path.join(home, "dispatch");
    const plist = path.join(home, "dispatch.plist");
    await writeFile(runtime, "runtime");
    await writeFile(
      plist,
      `<plist><dict><key>ProgramArguments</key><array><string>${runtime}</string></array></dict></plist>`
    );
    const fakeBin = path.join(home, "node bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, "node"),
      `#!/bin/sh\nprintf 'delegated-node-ok'\n`
    );
    await chmod(path.join(fakeBin, "node"), 0o755);
    await writeFile(
      path.join(home, ".zprofile"),
      `export PATH="$HOME/node bin:$PATH"\n`
    );
    await mkdir(path.join(repo, ".dispatch"));
    await writeFile(
      path.join(repo, ".dispatch", "tools.json"),
      JSON.stringify({
        tools: [
          {
            name: "project_script",
            description: "Run a Node-backed project script.",
            command: ["node"],
          },
        ],
      })
    );

    const restored: NodeJS.ProcessEnv = {};
    const status = await restoreLegacyMacLaunchAgentEnvironment({
      platform: "darwin",
      serviceDefinitionPath: plist,
      runtimePath: runtime,
      inheritedEnv: {
        HOME: home,
        PATH: "/usr/bin:/bin",
      },
      targetEnv: restored,
      macShellPath: shell,
      environmentEmitter: "/usr/bin/env -0",
    });
    expect(status.state).toBe("resolved");

    const previousPath = process.env.PATH;
    try {
      process.env.PATH = restored.PATH;
      const [tool] = await loadRepoTools(repo);
      const result = await tool.run({ agentId: "agt_path", repoRoot: repo });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("delegated-node-ok");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("rejects a non-zsh executable instead of guessing argv", async () => {
    const result = await captureLegacyMacEnvironment({
      inheritedEnv: {},
      macShellPath: "/usr/bin/env",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        shell: null,
        reason: "missing_shell",
      })
    );
  });

  it("bounds a profile background child that keeps capture pipes open", async () => {
    const home = await tempHome();
    const shell = await fakeZsh(home);
    await writeFile(
      path.join(home, ".zprofile"),
      `(trap '' TERM; sleep 30) &\n`
    );

    const startedAt = Date.now();
    const result = await captureLegacyMacEnvironment({
      inheritedEnv: {
        HOME: home,
        PATH: "/usr/bin:/bin",
      },
      macShellPath: shell,
      environmentEmitter: "/usr/bin/env -0",
      timeoutMs: 100,
      terminationGraceMs: 100,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "timeout" })
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("terminates capture when profile output exceeds its cap", async () => {
    const home = await tempHome();
    const shell = await fakeZsh(home);
    await writeFile(
      path.join(home, ".zprofile"),
      `yes profile-output | head -c 4096\n`
    );

    const result = await captureLegacyMacEnvironment({
      inheritedEnv: {
        HOME: home,
        PATH: "/usr/bin:/bin",
      },
      macShellPath: shell,
      environmentEmitter: "/usr/bin/env -0",
      outputLimitBytes: 128,
      terminationGraceMs: 50,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "output_limit" })
    );
  });

  it.skipIf(!existsSync("/bin/zsh"))(
    "matches the legacy macOS explicit zprofile then zshrc ordering",
    async () => {
      const home = await tempHome();
      await writeFile(
        path.join(home, ".zprofile"),
        `export ORDER='zprofile'\nexport PROFILE_VALUE='yes'\n`
      );
      await writeFile(
        path.join(home, ".zshrc"),
        `export ORDER='zshrc'\nunset REMOVED_BY_PROFILE\n`
      );

      const result = await captureLegacyMacEnvironment({
        inheritedEnv: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          REMOVED_BY_PROFILE: "remove-me",
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.environment.ORDER).toBe("zshrc");
      expect(result.environment.PROFILE_VALUE).toBe("yes");
      expect(result.environment.REMOVED_BY_PROFILE).toBeUndefined();
      const implementation = await readFile(
        path.resolve(
          import.meta.dirname,
          "../src/startup/shell-environment.ts"
        ),
        "utf8"
      );
      expect(implementation).not.toContain("/usr/bin/env -0");
    }
  );
});

describe("shell environment protocol", () => {
  it("reads only the first launchd ProgramArgument", () => {
    expect(
      firstLaunchdProgramArgument(
        `<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/fake/dispatch</string></dict><key>ProgramArguments</key><array><string>/real/dispatch&amp;one</string><string>--flag</string></array></dict></plist>`
      )
    ).toBe("/real/dispatch&one");
  });

  it("activates only when a macOS LaunchAgent directly invokes this runtime", async () => {
    const dir = await tempHome();
    const runtime = path.join(dir, "dispatch");
    const directPlist = path.join(dir, "direct.plist");
    const wrapperPlist = path.join(dir, "wrapper.plist");
    await writeFile(runtime, "runtime");
    await writeFile(
      directPlist,
      `<plist><dict><key>ProgramArguments</key><array><string>${runtime}</string></array></dict></plist>`
    );
    await writeFile(
      wrapperPlist,
      `<plist><dict><key>ProgramArguments</key><array><string>/legacy/wrapper</string></array></dict></plist>`
    );

    await expect(
      shouldRestoreLegacyMacEnvironment({
        platform: "darwin",
        serviceDefinitionPath: directPlist,
        runtimePath: runtime,
      })
    ).resolves.toBe(true);
    await expect(
      shouldRestoreLegacyMacEnvironment({
        platform: "darwin",
        serviceDefinitionPath: wrapperPlist,
        runtimePath: runtime,
      })
    ).resolves.toBe(false);
    await expect(
      shouldRestoreLegacyMacEnvironment({
        platform: "linux",
        serviceDefinitionPath: directPlist,
        runtimePath: runtime,
      })
    ).resolves.toBe(false);
  });

  it("fails startup rather than silently using the minimal environment", async () => {
    const home = await tempHome();
    const runtime = path.join(home, "dispatch");
    const plist = path.join(home, "dispatch.plist");
    const shell = await fakeZsh(home);
    await writeFile(runtime, "runtime");
    await writeFile(
      plist,
      `<plist><dict><key>ProgramArguments</key><array><string>${runtime}</string></array></dict></plist>`
    );
    await writeFile(path.join(home, ".zprofile"), "exit 9\n");
    await expect(
      restoreLegacyMacLaunchAgentEnvironment({
        platform: "darwin",
        serviceDefinitionPath: plist,
        runtimePath: runtime,
        inheritedEnv: { HOME: home, PATH: "/usr/bin:/bin" },
        macShellPath: shell,
        environmentEmitter: "/usr/bin/env -0",
      })
    ).rejects.toThrow(/Legacy shell environment restoration failed/);
  });

  it("restores the environment before importing the server", async () => {
    const main = await readFile(
      path.resolve(import.meta.dirname, "../src/main.ts"),
      "utf8"
    );
    const restoreAt = main.indexOf(
      "await restoreLegacyMacLaunchAgentEnvironment()"
    );
    const serverAt = main.indexOf('await import("./server.js")');
    expect(restoreAt).toBeGreaterThan(0);
    expect(serverAt).toBeGreaterThan(restoreAt);
  });

  it("parses null-delimited values containing whitespace, newlines, and equals", () => {
    const output = Buffer.from(
      `profile noise\0BEGIN\0A=one two\0B=line 1\nline 2\0C=a=b=c\0END\0more noise`
    );
    expect(parseCapturedEnvironment(output, "BEGIN", "END")).toEqual({
      A: "one two",
      B: "line 1\nline 2",
      C: "a=b=c",
    });
  });

  it("rejects missing, duplicated, and out-of-order markers", () => {
    expect(parseCapturedEnvironment(Buffer.from("A=1\0"), "B", "E")).toBeNull();
    expect(
      parseCapturedEnvironment(Buffer.from("B\0B\0A=1\0E\0"), "B", "E")
    ).toBeNull();
    expect(
      parseCapturedEnvironment(Buffer.from("E\0A=1\0B\0"), "B", "E")
    ).toBeNull();
  });

  it("replaces rather than merges so profile unsets propagate", () => {
    const target: NodeJS.ProcessEnv = { KEEP: "old", REMOVE: "stale" };
    replaceProcessEnvironment({ KEEP: "new", ADDED: "yes" }, target);
    expect(target).toEqual({ KEEP: "new", ADDED: "yes" });
  });

  it("applies the legacy TERM default", () => {
    const target: NodeJS.ProcessEnv = { STALE: "remove" };
    applyCapturedEnvironment({ KEEP: "yes" }, target);
    expect(target).toEqual({ KEEP: "yes", TERM: "xterm-256color" });
  });
});
