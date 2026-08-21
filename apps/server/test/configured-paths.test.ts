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
