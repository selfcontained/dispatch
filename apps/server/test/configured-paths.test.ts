import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every path Dispatch reads from configuration must expand a leading `~`.
 *
 * Each of these modules resolves its own env var, so the expansion is easy to
 * add in one place and forget in another — which is what happened with
 * MEDIA_ROOT: a literal `~` produced a directory *named* `~` beside the
 * process working directory, writes succeeded, and nothing could find them
 * again. These assert the file lands at the expanded location and that no
 * literal-tilde directory is created anywhere.
 *
 * They cover both shapes present in the codebase: a path resolved inside a
 * function (applied-migrations-store) and one resolved once at module load
 * (release-store), which only reads the env var on first import.
 */

let tempHome: string;
const cleanup: string[] = [];

async function withTildeConfig<T>(
  envName: string,
  relative: string,
  body: (expected: string) => Promise<T>
): Promise<T> {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "dispatch-cfg-home-"));
  cleanup.push(tempHome);
  const prevHome = process.env.HOME;
  const prevValue = process.env[envName];
  // os.homedir() reads $HOME on POSIX, so this keeps the test off the real one.
  process.env.HOME = tempHome;
  process.env[envName] = `~/${relative}`;
  vi.resetModules();
  try {
    return await body(path.join(tempHome, relative));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevValue === undefined) delete process.env[envName];
    else process.env[envName] = prevValue;
  }
}

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
  await rm(path.join(process.cwd(), "~"), { recursive: true, force: true });
});

describe("configured paths expand a leading tilde", () => {
  it("DISPATCH_APPLIED_MIGRATIONS_STORE_PATH (resolved per call)", async () => {
    await withTildeConfig(
      "DISPATCH_APPLIED_MIGRATIONS_STORE_PATH",
      "state/applied-migrations.json",
      async (expected) => {
        const store = await import("../src/applied-migrations-store.js");
        await store.writeAppliedMigrationsState({
          appliedMigrations: {
            "some-id": { appliedAt: "now", targetTag: "v1" },
          },
        });
        expect((await stat(expected)).isFile()).toBe(true);
      }
    );
  });

  it("DISPATCH_RELEASE_STORE_PATH (resolved at module load)", async () => {
    await withTildeConfig(
      "DISPATCH_RELEASE_STORE_PATH",
      "state/release.json",
      async (expected) => {
        const store = await import("../src/release-store.js");
        await store.writeReleaseStore({
          tag: "v1.2.3",
          deployedAt: new Date(0).toISOString(),
        });
        expect((await stat(expected)).isFile()).toBe(true);
      }
    );
  });

  it("never creates a directory literally named ~", async () => {
    await withTildeConfig(
      "DISPATCH_APPLIED_MIGRATIONS_STORE_PATH",
      "state/applied-migrations.json",
      async () => {
        const store = await import("../src/applied-migrations-store.js");
        await store.writeAppliedMigrationsState({ appliedMigrations: {} });
        await expect(stat(path.join(process.cwd(), "~"))).rejects.toMatchObject(
          { code: "ENOENT" }
        );
      }
    );
  });
});

/**
 * The engine and CLI binary settings are the same story as the paths above,
 * with one twist: a bare command name has to survive untouched so
 * `resolveExecutable`'s PATH lookup still finds it. Only a value that names
 * a path gets `~` expanded.
 */
describe("configured executables expand a leading tilde", () => {
  const BIN_ENV = [
    "DISPATCH_CLAUDE_HARNESS_BIN",
    "DISPATCH_CODEX_HARNESS_BIN",
    "DISPATCH_GEMINI_BIN",
    "DISPATCH_OPENCODE_BIN",
    "DISPATCH_CLAUDE_BIN",
    "DISPATCH_CODEX_BIN",
    "DISPATCH_CURSOR_BIN",
    "DATABASE_URL",
    "DISPATCH_PORT",
    "HOME",
  ];

  it("for every engine and CLI bin, and leaves a bare command name alone", async () => {
    const saved = new Map(BIN_ENV.map((name) => [name, process.env[name]]));
    const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-cfg-bin-"));
    cleanup.push(home);
    try {
      process.env.HOME = home;
      // Neither the production database nor the production port: loadConfig
      // refuses both from an agent context, and this suite runs in one.
      process.env.DATABASE_URL =
        "postgres://dispatch:dispatch@127.0.0.1:5433/dispatch_cfg_probe";
      process.env.DISPATCH_PORT = "6799";
      process.env.DISPATCH_CLAUDE_HARNESS_BIN = "~/.local/bin/claude-agent-acp";
      process.env.DISPATCH_CODEX_HARNESS_BIN = "~/.local/bin/codex-acp";
      process.env.DISPATCH_GEMINI_BIN = "~/.local/bin/gemini";
      process.env.DISPATCH_OPENCODE_BIN = "~/.local/bin/opencode";
      process.env.DISPATCH_CLAUDE_BIN = "~/.local/bin/claude";
      process.env.DISPATCH_CURSOR_BIN = "~/.local/bin/agent";
      // The one bare name in the set: PATH lookup, not a path.
      process.env.DISPATCH_CODEX_BIN = "codex";
      vi.resetModules();
      const { loadConfig } = await import("../src/config.js");
      const config = loadConfig();
      const local = (name: string) => path.join(home, ".local", "bin", name);
      expect(config.claudeHarnessBin).toBe(local("claude-agent-acp"));
      expect(config.codexHarnessBin).toBe(local("codex-acp"));
      expect(config.geminiBin).toBe(local("gemini"));
      expect(config.opencodeBin).toBe(local("opencode"));
      expect(config.claudeBin).toBe(local("claude"));
      expect(config.cursorBin).toBe(local("agent"));
      expect(config.codexBin).toBe("codex");
      expect(config.codexBinConfigured).toBe(true);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
