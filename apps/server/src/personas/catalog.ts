import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
import {
  loadPersonas,
  toPersonaDefinition,
  type PersonaDefinition,
} from "./loader.js";
import { PERSONA_DIRS } from "./paths.js";

export const PERSONA_REFRESH_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const LOCK_TTL_MS = 5 * 60_000;
const cacheSchema = z.object({
  version: z.literal(1),
  nextRefreshAt: z.number(),
  failures: z.number(),
  updatedAt: z.number().nullable(),
  commit: z.string().nullable(),
  warning: z.string().optional(),
  warnings: z.array(z.string()),
  personas: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      body: z.string(),
      type: z.enum(["task", "review"]).optional(),
    })
  ),
});
type Cache = z.infer<typeof cacheSchema>;
export type PersonaCatalog = {
  personas: PersonaDefinition[];
  warnings: string[];
  refreshing: boolean;
  updatedAt: number | null;
};

/** One catalog per Git common directory + origin identity, shared by all worktrees.
 * Fetch only remote HEAD into a private ref: no checkout, branch, index or
 * FETCH_HEAD changes. No GitHub API, remote polling timer, or force-refresh bypass.
 */
export class PersonaCatalogCache {
  private pending = new Map<string, Promise<void>>();
  private unavailable = new Set<string>();
  constructor(
    private run: CommandRunner = runCommand,
    private now = Date.now
  ) {}

  private async git(cwd: string, args: string[]) {
    return (
      await this.run("git", ["-C", cwd, ...args], {
        timeoutMs: 20_000,
        trimOutput: false,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      })
    ).stdout;
  }

  private async read(file: string): Promise<Cache | null> {
    try {
      if ((await stat(file)).size > 32 * 1024 * 1024) return null;
      return cacheSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return null;
    }
  }

  private async write(file: string, cache: Cache) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async readRef(cwd: string, ref: string) {
    const commit = (
      await this.git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])
    ).trim();
    const entries = (
      await this.git(cwd, [
        "ls-tree",
        "-r",
        "-z",
        "-l",
        commit,
        "--",
        ...PERSONA_DIRS,
      ])
    )
      .split("\0")
      .filter(Boolean);
    const personas: PersonaDefinition[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const directory of PERSONA_DIRS) {
      for (const entry of entries) {
        const [metadata, name] = entry.split("\t");
        if (
          !name?.startsWith(`${directory}/`) ||
          !name.endsWith(".md") ||
          name.slice(directory.length + 1).includes("/")
        )
          continue;
        const slug = path.basename(name, ".md");
        if (seen.has(slug)) continue;
        seen.add(slug);
        const [mode, kind, object, size] = metadata.trim().split(/\s+/);
        bytes += Number(size) || 0;
        if (seen.size > 100 || bytes > 4 * 1024 * 1024) {
          warnings.push("Persona catalog exceeds the 100-file or 4 MiB limit.");
          return { personas, warnings, commit };
        }
        if (
          kind !== "blob" ||
          !["100644", "100755"].includes(mode) ||
          Number(size) > 256 * 1024
        ) {
          warnings.push(
            `Could not load persona ${name}: unsupported file or larger than 256 KiB.`
          );
          continue;
        }
        try {
          personas.push(
            toPersonaDefinition(
              slug,
              await this.git(cwd, ["cat-file", "blob", object])
            )
          );
        } catch {
          warnings.push(
            `Could not load persona ${name}: invalid persona definition.`
          );
        }
      }
    }
    return { personas, warnings, commit };
  }

  private async refresh(cwd: string, file: string, ref: string) {
    const lock = `${file}.lock`;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Crash recovery. Normal refreshes have a bounded network timeout.
      if (this.now() - (await stat(lock)).mtimeMs > LOCK_TTL_MS)
        await rm(lock, { recursive: true, force: true });
      return;
    }
    try {
      let cached = await this.read(file);
      if (cached && cached.nextRefreshAt > this.now()) return;
      if (!cached) {
        cached = {
          version: 1,
          personas: [],
          warnings: [],
          commit: null,
          updatedAt: null,
          failures: 0,
          nextRefreshAt: 0,
        };
      }
      // Persist the attempt BEFORE contacting the remote, including across process restarts.
      cached.nextRefreshAt =
        this.now() +
        Math.min(
          MAX_BACKOFF_MS,
          PERSONA_REFRESH_MS * 2 ** Math.min(cached.failures, 4)
        );
      await this.write(file, cached);
      try {
        await this.git(cwd, [
          "-c",
          "credential.interactive=false",
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "origin",
          `+HEAD:${ref}`,
        ]);
        const result = await this.readRef(cwd, ref);
        await this.write(file, {
          version: 1,
          ...result,
          updatedAt: this.now(),
          failures: 0,
          nextRefreshAt: this.now() + PERSONA_REFRESH_MS,
        });
      } catch {
        cached.failures += 1;
        cached.nextRefreshAt =
          this.now() +
          Math.min(
            MAX_BACKOFF_MS,
            PERSONA_REFRESH_MS * 2 ** Math.min(cached.failures, 4)
          );
        cached.warning =
          "Could not refresh personas from origin. Using cached definitions; retry is delayed automatically.";
        await this.write(file, cached);
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async get(cwd: string, waitForRefresh = false): Promise<PersonaCatalog> {
    const common = await this.git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
      .then((s) => s.trim())
      .catch(() => null);
    const remote = common
      ? await this.git(cwd, ["remote", "get-url", "origin"])
          .then((s) => s.trim())
          .catch(() => null)
      : null;
    if (!common || !remote) {
      const warnings: string[] = [];
      return {
        personas: await loadPersonas(
          common && path.basename(common) === ".git"
            ? path.dirname(common)
            : cwd,
          warnings
        ),
        warnings,
        refreshing: false,
        updatedAt: null,
      };
    }
    const identity = createHash("sha256").update(remote).digest("hex");
    const file = path.join(
      common,
      "dispatch",
      "persona-catalog",
      `${identity}.json`
    );
    let cached = await this.read(file);
    if (
      (!cached || cached.nextRefreshAt <= this.now()) &&
      !this.pending.has(file)
    ) {
      const work = this.refresh(
        cwd,
        file,
        `refs/dispatch/persona-catalog/${identity}`
      )
        .then(() => {
          this.unavailable.delete(file);
        })
        .catch(() => {
          this.unavailable.add(file);
        })
        .finally(() => this.pending.delete(file));
      this.pending.set(file, work);
    }
    if (waitForRefresh) {
      await this.pending.get(file);
      cached = await this.read(file);
      // Another server may own the cold refresh. A launch can wait briefly for
      // that publication, while UI requests always remain non-blocking.
      for (let attempt = 0; !cached?.updatedAt && attempt < 250; attempt++) {
        const held = await stat(`${file}.lock`)
          .then((s) => this.now() - s.mtimeMs < LOCK_TTL_MS)
          .catch(() => false);
        if (!held) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        cached = await this.read(file);
      }
    }
    const locked = await stat(`${file}.lock`)
      .then((s) => this.now() - s.mtimeMs < LOCK_TTL_MS)
      .catch(() => false);
    return {
      personas: cached?.personas ?? [],
      warnings: [
        ...(this.unavailable.has(file)
          ? [
              "Could not store the persona catalog. Check repository cache permissions.",
            ]
          : []),
        ...(cached?.warnings ?? []),
        ...(cached?.warning ? [cached.warning] : []),
      ],
      refreshing: this.pending.has(file) || locked,
      updatedAt: cached?.updatedAt ?? null,
    };
  }
}

export const personaCatalog = new PersonaCatalogCache();
