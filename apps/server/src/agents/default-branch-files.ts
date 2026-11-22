import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
import type { DefaultBranchFilesReply } from "@dispatch/runner-protocol";
import { toPersonaDefinition } from "../personas/loader.js";

export const DEFAULT_BRANCH_REFRESH_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const LOCK_TTL_MS = 5 * 60_000;
export const PERSONA_CATALOG_LIMIT_WARNING =
  "Persona catalog exceeds the 100-file or 4 MiB limit.";
const REFRESH_WARNING =
  "Could not refresh personas from origin. Using cached definitions; retry is delayed automatically.";
const cacheSchema = z.object({
  version: z.literal(1),
  nextRefreshAt: z.number(),
  failures: z.number(),
  updatedAt: z.number().nullable(),
  commit: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable(),
  warning: z.string().optional(),
});
type Cache = z.infer<typeof cacheSchema>;
/** One default-branch snapshot per Git common directory + origin identity, shared by all worktrees.
 * Fetch only remote HEAD into a private ref: no checkout, branch, index or
 * FETCH_HEAD changes. No GitHub API, remote polling timer, or force-refresh bypass.
 */
export class DefaultBranchFiles {
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

  private async readFiles(cwd: string, commit: string, directories: string[]) {
    const files: DefaultBranchFilesReply["files"] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    const entries = (
      await this.git(cwd, [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        "-l",
        commit,
        "--",
        ...directories,
      ])
    ).split("\0");
    for (const directory of directories) {
      for (const entry of entries) {
        const [metadata, filePath] = entry.split("\t");
        if (
          !filePath?.startsWith(`${directory}/`) ||
          !filePath.endsWith(".md") ||
          filePath.slice(directory.length + 1).includes("/")
        )
          continue;
        const slug = path.basename(filePath, ".md");
        if (seen.has(slug)) continue;
        seen.add(slug);

        const [mode, kind, blob, size] = metadata.trim().split(/\s+/);
        bytes += Number(size) || 0;
        if (seen.size > 100 || bytes > 4 * 1024 * 1024) {
          warnings.push(PERSONA_CATALOG_LIMIT_WARNING);
          return { files, truncated: true, warnings };
        }
        if (
          kind !== "blob" ||
          !["100644", "100755"].includes(mode) ||
          Number(size) > 256 * 1024
        ) {
          warnings.push(
            `Could not load persona ${filePath}: unsupported file or larger than 256 KiB.`
          );
          continue;
        }
        try {
          const content = await this.git(cwd, ["cat-file", "blob", blob]);
          toPersonaDefinition(slug, content);
          files.push({ path: filePath, content });
        } catch {
          warnings.push(
            `Could not load persona ${filePath}: invalid persona definition.`
          );
        }
      }
    }
    return { files, truncated: false, warnings };
  }

  private async refresh(
    cwd: string,
    file: string,
    ref: string,
    legacyFile: string
  ) {
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
      let cached = (await this.read(file)) ?? (await this.read(legacyFile));
      if (cached && cached.nextRefreshAt > this.now()) return;
      if (!cached) {
        cached = {
          version: 1,
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
          DEFAULT_BRANCH_REFRESH_MS * 2 ** Math.min(cached.failures, 4)
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
        const commit = (
          await this.git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])
        ).trim();
        await this.write(file, {
          version: 1,
          commit,
          updatedAt: this.now(),
          failures: 0,
          nextRefreshAt: this.now() + DEFAULT_BRANCH_REFRESH_MS,
        });
      } catch {
        cached.failures += 1;
        cached.nextRefreshAt =
          this.now() +
          Math.min(
            MAX_BACKOFF_MS,
            DEFAULT_BRANCH_REFRESH_MS * 2 ** Math.min(cached.failures, 4)
          );
        cached.warning = REFRESH_WARNING;
        await this.write(file, cached);
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async get(
    cwd: string,
    directories: string[],
    waitForRefresh: boolean
  ): Promise<DefaultBranchFilesReply> {
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
    if (!common || !remote)
      return {
        kind: "defaultBranchFiles",
        hasOrigin: false,
        files: [],
        warnings: [],
        refreshing: false,
        updatedAt: null,
        truncated: false,
      };
    const identity = createHash("sha256").update(remote).digest("hex");
    const file = path.join(
      common,
      "dispatch",
      "default-branch",
      `${identity}.json`
    );
    // Reuse the fetched commit and cooldown from the old format, without
    // depending on its parsed contents. Keep the legacy ref as the GC root.
    const legacyFile = path.join(
      common,
      "dispatch",
      "persona-catalog",
      `${identity}.json`
    );
    let cached = (await this.read(file)) ?? (await this.read(legacyFile));
    if (
      (!cached || cached.nextRefreshAt <= this.now()) &&
      !this.pending.has(file)
    ) {
      const work = this.refresh(
        cwd,
        file,
        `refs/dispatch/persona-catalog/${identity}`,
        legacyFile
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
      cached = (await this.read(file)) ?? (await this.read(legacyFile));
      // Another server may own the cold refresh. A launch can wait briefly for
      // that publication, while UI requests always remain non-blocking.
      for (let attempt = 0; !cached?.updatedAt && attempt < 250; attempt++) {
        const held = await stat(`${file}.lock`)
          .then((s) => this.now() - s.mtimeMs < LOCK_TTL_MS)
          .catch(() => false);
        if (!held) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        cached = (await this.read(file)) ?? (await this.read(legacyFile));
      }
    }
    const locked = await stat(`${file}.lock`)
      .then((s) => this.now() - s.mtimeMs < LOCK_TTL_MS)
      .catch(() => false);
    const refreshing = this.pending.has(file) || locked;
    const { warnings: fileWarnings, ...listing } = cached?.commit
      ? await this.readFiles(cwd, cached.commit, directories).catch(() => ({
          files: [],
          truncated: true,
          warnings: ["The default-branch file listing was incomplete."],
        }))
      : { files: [], truncated: false, warnings: [] as string[] };
    return {
      kind: "defaultBranchFiles",
      hasOrigin: true,
      ...listing,
      warnings: [
        ...(this.unavailable.has(file)
          ? [
              "Could not store the persona catalog. Check repository cache permissions.",
            ]
          : []),
        ...fileWarnings,
        ...(cached?.warning ? [REFRESH_WARNING] : []),
      ],
      refreshing,
      updatedAt: cached?.updatedAt ?? null,
    };
  }
}
