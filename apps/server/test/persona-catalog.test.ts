import { createPersonaHandlers } from "../src/server/mcp-persona-handlers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PersonaCatalogCache,
  PERSONA_REFRESH_MS,
  personaCatalog,
} from "../src/personas/catalog.js";
import {
  runCommand,
  type CommandRunner,
} from "../src/shared/lib/run-command.js";
import {
  discoverPersonas,
  resolveLaunchPersona,
} from "../src/personas/resolve.js";

let directory: string,
  remote: string,
  author: string,
  checkout: string,
  worktree: string;
let now: number, fetches: number, rejectFetch: boolean;
const git = async (cwd: string, ...args: string[]) =>
  (await runCommand("git", ["-C", cwd, ...args])).stdout;
const runner: CommandRunner = async (command, args, options) => {
  if (args.includes("fetch")) {
    fetches++;
    if (rejectFetch) throw new Error("offline");
  }
  return runCommand(command, args, options);
};
async function publish(body: string, name = "builder") {
  await mkdir(path.join(author, ".agents/personas"), { recursive: true });
  await writeFile(
    path.join(author, `.agents/personas/${name}.md`),
    `---\nname: ${name}\ntype: task\n---\n${body}`
  );
  await git(author, "add", ".");
  await git(author, "commit", "-m", body);
  await git(author, "push", "origin", "trunk");
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "persona-catalog-"));
  remote = path.join(directory, "remote.git");
  author = path.join(directory, "author");
  checkout = path.join(directory, "checkout");
  worktree = path.join(directory, "worktree");
  await git(directory, "init", "--bare", "--initial-branch=trunk", remote);
  await git(directory, "clone", remote, author);
  await git(author, "config", "user.email", "test@example.com");
  await git(author, "config", "user.name", "Test");
  await git(author, "commit", "--allow-empty", "-m", "initial");
  await git(author, "push", "origin", "trunk");
  await git(directory, "clone", remote, checkout);
  await git(checkout, "worktree", "add", "-b", "feature", worktree);
  now = Date.now();
  fetches = 0;
  rejectFetch = false;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("shared remote persona catalog", () => {
  it("reads remote default HEAD without updating either checkout, branches, index, or FETCH_HEAD", async () => {
    await publish("remote instructions");
    const before = await git(checkout, "rev-parse", "HEAD");
    const cache = new PersonaCatalogCache(runner, () => now);
    const result = await cache.get(checkout, true);
    expect(result.personas[0].body).toBe("remote instructions");
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(before);
    expect(await git(checkout, "rev-parse", "refs/remotes/origin/trunk")).toBe(
      before
    );
    expect(await git(checkout, "status", "--porcelain")).toBe("");
    await expect(
      readFile(path.join(checkout, ".git/FETCH_HEAD"))
    ).rejects.toThrow();
    expect(fetches).toBe(1);
  });
  it("coalesces concurrent worktrees and persists cooldown across service instances", async () => {
    await publish("one");
    const first = new PersonaCatalogCache(runner, () => now);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        first.get(i % 2 ? checkout : worktree, true)
      )
    );
    expect(fetches).toBe(1);
    await new PersonaCatalogCache(runner, () => now).get(worktree, true);
    expect(fetches).toBe(1);
    await publish("two");
    now += PERSONA_REFRESH_MS + 1;
    const next = await new PersonaCatalogCache(runner, () => now).get(
      checkout,
      true
    );
    expect(next.personas[0].body).toBe("two");
    expect(fetches).toBe(2);
  });
  it("uses a disk lock across independent service instances", async () => {
    await publish("shared");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: CommandRunner = async (command, args, options) => {
      if (args.includes("fetch")) {
        entered();
        await held;
      }
      return runner(command, args, options);
    };
    const first = new PersonaCatalogCache(delayed, () => now);
    const second = new PersonaCatalogCache(runner, () => now);
    const refreshing = first.get(checkout, true);
    await started;
    try {
      const result = await second.get(worktree);
      expect(result.refreshing).toBe(true);
      expect(fetches).toBe(0);
    } finally {
      release();
    }
    await refreshing;
    expect((await second.get(worktree, true)).personas[0].body).toBe("shared");
    expect(fetches).toBe(1);
  });
  it("MCP discovery returns immediately while a remote refresh is held", async () => {
    await publish("remote");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: CommandRunner = async (command, args, options) => {
      if (args.includes("fetch")) await held;
      return runner(command, args, options);
    };
    const cache = new PersonaCatalogCache(delayed);
    const spy = vi
      .spyOn(personaCatalog, "get")
      .mockImplementation((cwd, wait) => cache.get(cwd, wait));
    const handlers = createPersonaHandlers({} as never);
    try {
      const result = await handlers.listPersonas(checkout);
      expect(result.warnings.join()).toContain("refreshing in the background");
      expect(fetches).toBe(0);
    } finally {
      release();
      await cache.get(checkout, true);
      spy.mockRestore();
    }
  });
  it("does not reuse definitions after origin changes", async () => {
    await publish("first origin");
    const cache = new PersonaCatalogCache(runner, () => now);
    await cache.get(checkout, true);
    const other = path.join(directory, "other.git");
    await git(directory, "init", "--bare", "--initial-branch=trunk", other);
    await git(checkout, "remote", "set-url", "origin", other);
    const result = await cache.get(checkout, true);
    expect(result.personas).toEqual([]);
    expect(result.warnings.join()).toContain("Could not refresh");
    expect(fetches).toBe(2);
  });
  it("serves last good definitions during refresh and backs off failures across restarts", async () => {
    await publish("retained");
    const cache = new PersonaCatalogCache(runner, () => now);
    await cache.get(checkout, true);
    rejectFetch = true;
    now += PERSONA_REFRESH_MS + 1;
    const stale = await cache.get(checkout);
    expect(stale.personas[0].body).toBe("retained");
    expect(stale.refreshing).toBe(true);
    const failed = await cache.get(checkout, true);
    expect(failed.personas[0].body).toBe("retained");
    expect(failed.warnings.join()).toContain("Could not refresh");
    now += PERSONA_REFRESH_MS + 1;
    await new PersonaCatalogCache(runner, () => now).get(checkout, true);
    expect(fetches).toBe(2);
    now += PERSONA_REFRESH_MS + 1;
    await new PersonaCatalogCache(runner, () => now).get(checkout, true);
    expect(fetches).toBe(3);
  });
  it("drops deleted definitions after a successful refresh and retains other valid files", async () => {
    await publish("one");
    const cache = new PersonaCatalogCache(runner, () => now);
    await cache.get(checkout, true);
    await git(author, "rm", ".agents/personas/builder.md");
    await publish("two", "replacement");
    await writeFile(
      path.join(author, ".agents/personas/bad.md"),
      "---\ntype: typo\n---\nbad"
    );
    await git(author, "add", ".");
    await git(author, "commit", "-m", "bad file");
    await git(author, "push");
    now += PERSONA_REFRESH_MS + 1;
    const result = await cache.get(checkout, true);
    expect(result.personas.map((p) => p.slug)).toEqual(["replacement"]);
    expect(result.warnings.join()).toContain("bad.md");
  });
  it("uses worktree overrides for existing agents but the catalog for new launches", async () => {
    await publish("remote");
    await mkdir(path.join(worktree, ".agents/personas"), { recursive: true });
    await writeFile(
      path.join(worktree, ".agents/personas/builder.md"),
      "---\ntype: task\n---\nlocal override"
    );
    expect(
      (await resolveLaunchPersona(checkout, "builder", "task", "catalog")).body
    ).toBe("remote");
    expect((await resolveLaunchPersona(worktree, "builder", "task")).body).toBe(
      "local override"
    );
    expect(
      (await discoverPersonas(worktree, "workspace", true)).personas.find(
        (p) => p.slug === "builder"
      )?.body
    ).toBe("local override");
    await writeFile(
      path.join(worktree, ".agents/personas/builder.md"),
      "---\ntype: typo\n---\nbad override"
    );
    await expect(
      resolveLaunchPersona(worktree, "builder", "task")
    ).rejects.toThrow("Invalid persona type");
  });
  it("keeps local personas usable without a remote or a git repository", async () => {
    await git(checkout, "remote", "remove", "origin");
    await mkdir(path.join(checkout, ".agents/personas"), { recursive: true });
    await writeFile(
      path.join(checkout, ".agents/personas/local.md"),
      "---\ntype: task\n---\nlocal"
    );
    expect(
      (await new PersonaCatalogCache(runner).get(worktree, true)).personas[0]
        .slug
    ).toBe("local");
    expect(fetches).toBe(0);
  });
});
