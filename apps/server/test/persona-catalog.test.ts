import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultBranchFiles,
  inspectCheckout,
} from "./helpers/checkout-inspection.js";
import { createPersonaHandlers } from "../src/server/mcp-persona-handlers.js";
import { DefaultBranchFiles } from "./helpers/default-branch-files.js";
import { RunnerCapabilityUnavailable } from "../src/agents/remote/service.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PersonaCatalogCache as ProductionPersonaCatalogCache,
  PERSONA_REFRESH_MS,
} from "../src/personas/catalog.js";
import {
  runCommand,
  type CommandRunner,
} from "../src/shared/lib/run-command.js";
import { listPersonas, resolvePersona } from "../src/personas/resolve.js";

import {
  launchPersonaScope,
  personaScopeFor,
} from "./helpers/persona-scope.js";

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
    const cache = new DefaultBranchFiles(delayed);
    const spy = vi
      .spyOn(defaultBranchFiles, "get")
      .mockImplementation((cwd, directories, wait) =>
        cache.get(cwd, directories, wait)
      );
    const handlers = createPersonaHandlers({
      agentManager: {
        getAgent: async () => ({ cwd: checkout }),
        inspectCheckout: (
          _agent: unknown,
          query: Parameters<typeof inspectCheckout>[1]
        ) => inspectCheckout(checkout, query),
      },
    } as never);
    try {
      const result = await handlers.listPersonas("author");
      expect(result.warnings.join()).toContain("refreshing in the background");
      expect(fetches).toBe(0);
    } finally {
      release();
      await cache.get(checkout, [".agents/personas"], true);
      spy.mockRestore();
    }
  });
  it.each(["local", "runner"])(
    "lists and resolves a %s session's personas with checkout precedence",
    async (placement) => {
      await publish("default instructions");
      const agent = {
        id: "author",
        cwd: placement === "local" ? worktree : "runner://rnr_test/session",
      } as never;
      const manager = {
        getAgent: async () => agent,
        inspectCheckout: (
          _agent: unknown,
          query: Parameters<typeof inspectCheckout>[1]
        ) => inspectCheckout(worktree, query),
      } as never;
      const handlers = createPersonaHandlers({
        agentManager: manager,
      } as never);
      expect(
        (await resolvePersona(personaScopeFor({ manager, agent }), "builder"))
          .body
      ).toBe("default instructions");
      expect((await handlers.listPersonas("author")).personas).toContainEqual(
        expect.objectContaining({ slug: "builder", name: "builder" })
      );
      await mkdir(path.join(worktree, ".agents/personas"), { recursive: true });
      await writeFile(
        path.join(worktree, ".agents/personas/builder.md"),
        "---\ntype: task\nname: Local Builder\n---\ncheckout instructions"
      );
      expect((await handlers.listPersonas("author")).personas).toContainEqual(
        expect.objectContaining({ slug: "builder", name: "Local Builder" })
      );
      expect(
        (await resolvePersona(personaScopeFor({ manager, agent }), "builder"))
          .body
      ).toBe("checkout instructions");
    }
  );

  it("keeps checkout personas and built-ins available to an older runner", async () => {
    const agent = { id: "author", cwd: "runner://rnr_old/proof" } as never;
    const manager = {
      getAgent: async () => agent,
      inspectCheckout: async (
        _agent: unknown,
        query: { kind: string; path?: string }
      ) => {
        if (query.kind === "defaultBranchFiles")
          throw new RunnerCapabilityUnavailable(
            "Update the runner to read default-branch files."
          );
        if (query.kind === "listFiles")
          return {
            kind: "listFiles",
            names: query.path === ".agents/personas" ? ["local.md"] : [],
          };
        return {
          kind: "readFile",
          content:
            query.path === ".agents/personas/local.md"
              ? "Checkout instructions"
              : null,
        };
      },
    } as never;
    const handlers = createPersonaHandlers({ agentManager: manager } as never);
    const list = await handlers.listPersonas("author");
    expect(list.personas.map(({ slug }) => slug)).toEqual([
      "local",
      "code-review",
    ]);
    expect(list.warnings.join()).toContain("Update the runner");
    expect(
      (await resolvePersona(personaScopeFor({ manager, agent }), "code-review"))
        .slug
    ).toBe("code-review");
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
  it("reuses a pinned snapshot from the legacy cache while offline", async () => {
    await publish("retained from legacy cache");
    const initial = new PersonaCatalogCache(runner, () => now);
    await initial.get(checkout, true);
    const base = path.join(checkout, ".git/dispatch");
    const snapshotDir = path.join(base, "default-branch");
    const legacyDir = path.join(base, "persona-catalog");
    const [file] = await readdir(snapshotDir);
    const metadata = JSON.parse(
      await readFile(path.join(snapshotDir, file), "utf8")
    );
    await mkdir(legacyDir);
    await writeFile(
      path.join(legacyDir, file),
      JSON.stringify({
        ...metadata,
        personas: [],
        warnings: [],
      })
    );
    await rm(snapshotDir, { recursive: true });
    rejectFetch = true;
    now += PERSONA_REFRESH_MS + 1;
    const restarted = await new PersonaCatalogCache(runner, () => now).get(
      worktree,
      true
    );
    expect(restarted.personas[0].body).toBe("retained from legacy cache");
    expect(restarted.warnings.join()).toContain("Could not refresh");
    expect(fetches).toBe(2);
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
  it("counts only Markdown personas toward the default-branch file cap", async () => {
    const personas = path.join(author, ".agents/personas");
    await mkdir(personas, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(path.join(personas, `a-${index}.txt`), "supporting text")
      )
    );
    await publish("instructions", "z");

    const result = await new PersonaCatalogCache(runner, () => now).get(
      checkout,
      true
    );
    expect(result.personas.map(({ slug }) => slug)).toEqual(["z"]);
    expect(result.warnings).toEqual([]);
  });

  it("counts raw Git blob sizes toward the default-branch byte cap", async () => {
    const personas = path.join(author, ".agents/personas");
    await mkdir(personas, { recursive: true });
    const header = "---\ntype: task\n---\n";
    const content = header + '"'.repeat(256 * 1024 - header.length);
    const slugs = Array.from(
      { length: 16 },
      (_, index) => `persona-${String(index).padStart(2, "0")}`
    );
    await Promise.all(
      slugs.map((slug) => writeFile(path.join(personas, `${slug}.md`), content))
    );
    await git(author, "add", ".");
    await git(author, "commit", "-m", "Catalog with 4 MiB of raw Markdown");
    await git(author, "push", "origin", "trunk");

    const result = await new PersonaCatalogCache(runner, () => now).get(
      checkout,
      true
    );
    expect(result.personas.map(({ slug }) => slug)).toEqual(slugs);
    expect(result.warnings).toEqual([]);
  });

  it("names a committed persona symlink in a warning instead of skipping it", async () => {
    await publish("one");
    await symlink("builder.md", path.join(author, ".agents/personas/alias.md"));
    await git(author, "add", ".");
    await git(author, "commit", "-m", "symlink");
    await git(author, "push");
    const result = await new PersonaCatalogCache(runner, () => now).get(
      checkout,
      true
    );
    expect(result.personas.map((p) => p.slug)).toEqual(["builder"]);
    expect(result.warnings).toEqual([
      "Could not load persona .agents/personas/alias.md: unsupported file or larger than 256 KiB.",
    ]);
  });
  it("uses worktree overrides for existing agents but the catalog for new launches", async () => {
    await publish("remote");
    await mkdir(path.join(worktree, ".agents/personas"), { recursive: true });
    await writeFile(
      path.join(worktree, ".agents/personas/builder.md"),
      "---\ntype: task\n---\nlocal override"
    );
    expect(
      (
        await resolvePersona(
          personaScopeFor({ cwd: checkout }),
          "builder",
          "task"
        )
      ).body
    ).toBe("remote");
    expect(
      (
        await resolvePersona(
          personaScopeFor({ cwd: worktree, source: "workspace" }),
          "builder",
          "task"
        )
      ).body
    ).toBe("local override");
    expect(
      (
        await listPersonas(
          personaScopeFor({ cwd: worktree, source: "workspace" }),
          "task",
          true
        )
      ).personas.find((p) => p.slug === "builder")?.body
    ).toBe("local override");
    await writeFile(
      path.join(worktree, ".agents/personas/builder.md"),
      "---\ntype: typo\n---\nbad override"
    );
    await expect(
      resolvePersona(
        personaScopeFor({ cwd: worktree, source: "workspace" }),
        "builder",
        "task"
      )
    ).rejects.toThrow("Invalid persona type");
  });
  it.each([
    ["local folder", (root: string) => personaScopeFor({ cwd: root })],
    ["local project", (root: string) => personaScopeFor({ projectRoot: root })],
    [
      // A runner project without a repository (or a runner that cannot read
      // it) keeps today's answer: the project's folder.
      "runner project",
      (root: string) =>
        launchPersonaScope({ checkoutReadRunners: () => ({}) } as never, {
          placement: { runner: "rnr_test" } as never,
          cwd: "runner://rnr_test/session",
          projectRoot: root,
          repository: null,
        }),
    ],
  ] as const)(
    "lists the same task definition it resolves for a %s",
    async (_name, target) => {
      await publish("catalog instructions");
      const scope = target(checkout);
      const listed = await listPersonas(scope, "task", true);
      expect(listed.personas.map((persona) => persona.slug)).toEqual([
        "builder",
      ]);
      expect(await resolvePersona(scope, "builder", "task")).toEqual(
        listed.personas[0]
      );
    }
  );

  it("limits a runner repository without a project to built-ins", async () => {
    const scope = launchPersonaScope(
      { checkoutReadRunners: () => ({}) } as never,
      { placement: { runner: "rnr_test" } as never, repository: null }
    );
    const listed = await listPersonas(scope, "review", true);
    expect(listed.personas.map((persona) => persona.slug)).toEqual([
      "code-review",
    ]);
    expect(await resolvePersona(scope, "code-review", "review")).toEqual(
      listed.personas[0]
    );
    expect((await listPersonas(scope, "task")).personas).toEqual([]);
    await expect(resolvePersona(scope, "builder", "task")).rejects.toThrow(
      "not found"
    );
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

it("keeps invalid-before-unsupported warnings ordered and invalid content off the wire", async () => {
  await publish("valid", "c-valid");
  await writeFile(
    path.join(author, ".agents/personas/a-invalid.md"),
    "---\ntype: typo\n---\nbad"
  );
  await symlink("c-valid.md", path.join(author, ".agents/personas/b-link.md"));
  await git(author, "add", ".");
  await git(author, "commit", "-m", "ordered invalid fixtures");
  await git(author, "push");
  const reply = await new DefaultBranchFiles(runner, () => now).get(
    checkout,
    [".agents/personas"],
    true
  );
  expect(reply.files.map((file) => file.path)).toEqual([
    ".agents/personas/c-valid.md",
  ]);
  expect(reply.warnings).toEqual([
    "Could not load persona .agents/personas/a-invalid.md: invalid persona definition.",
    "Could not load persona .agents/personas/b-link.md: unsupported file or larger than 256 KiB.",
  ]);
});

it("the enrolled runner's self-exec worker receives the exact definition parser", async () => {
  await publish("valid", "c-valid");
  await writeFile(
    path.join(author, ".agents/personas/a-invalid.md"),
    "---\ntype: typo\n---\nbad"
  );
  await symlink("c-valid.md", path.join(author, ".agents/personas/b-link.md"));
  await git(author, "add", ".");
  await git(author, "commit", "-m", "worker parser fixtures");
  await git(author, "push");
  const reply = await new Promise<{
    data: { files: Array<{ path: string }>; warnings: string[] };
  }>((resolve, reject) => {
    const worker = execFile(
      "bun",
      [
        "--no-env-file",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "runner-worker",
        "read",
        checkout,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        }
      }
    );
    worker.stdin!.end(
      JSON.stringify({
        op: "checkout.defaultFiles",
        request: { dirs: [".agents/personas"], wait: true },
      })
    );
  });
  expect(reply.data.files.map((file) => file.path)).toEqual([
    ".agents/personas/c-valid.md",
  ]);
  expect(reply.data.warnings).toEqual([
    "Could not load persona .agents/personas/a-invalid.md: invalid persona definition.",
    "Could not load persona .agents/personas/b-link.md: unsupported file or larger than 256 KiB.",
  ]);
});

class PersonaCatalogCache extends ProductionPersonaCatalogCache {
  override get(cwd: string, wait = false) {
    return super.get(cwd, wait, {});
  }
}
