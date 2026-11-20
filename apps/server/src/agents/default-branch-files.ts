import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
import type { DefaultBranchFilesReply } from "@dispatch/runner-protocol";
import {
  DEFAULT_BRANCH_FILE_LIMIT,
  DEFAULT_BRANCH_REPLY_BYTES,
} from "@dispatch/runner-protocol";

export const DEFAULT_BRANCH_REFRESH_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const LOCK_TTL_MS = 5 * 60_000;
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
    let truncated = false;
    let bytes = 1024; // Envelope and metadata.
    for (const directory of directories) {
      // A tree lookup treats the supplied directory as a literal path.
      const tree = await this.git(cwd, [
        "rev-parse",
        "--verify",
        `${commit}:${directory}`,
      ]).catch(() => null);
      const object = tree?.trim();
      if (
        !object ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object) ||
        (await this.git(cwd, ["cat-file", "-t", object])).trim() !== "tree"
      )
        continue;
      const entries = await this.git(cwd, ["ls-tree", "-z", "-l", object]);
      for (const entry of entries.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab === -1) continue;
        const name = entry.slice(tab + 1);
        const [mode, kind, blob, size] = entry
          .slice(0, tab)
          .trim()
          .split(/\s+/);
        if (
          kind !== "blob" ||
          !["100644", "100755"].includes(mode) ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob) ||
          !name ||
          name.includes("\\") ||
          name.toLowerCase() === ".git"
        )
          continue;
        const filePath = `${directory}/${name}`;
        if (filePath.length > 4096) continue;
        if (Number(size) > 256 * 1024) {
          truncated = true;
          continue;
        }
        if (files.length >= DEFAULT_BRANCH_FILE_LIMIT)
          return { files, truncated: true };
        const content = await this.git(cwd, ["cat-file", "blob", blob]);
        if (Buffer.byteLength(content) > 256 * 1024) {
          truncated = true;
          continue;
        }
        const file = { path: filePath, content };
        bytes += Buffer.byteLength(JSON.stringify(file)) + 1;
        if (bytes > DEFAULT_BRANCH_REPLY_BYTES)
          return { files, truncated: true };
        files.push(file);
      }
    }
    return { files, truncated };
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
        cached.warning =
          "Could not refresh the default branch from origin. Using cached files; retry is delayed automatically.";
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
    return {
      kind: "defaultBranchFiles",
      hasOrigin: true,
      ...(cached?.commit
        ? await this.readFiles(cwd, cached.commit, directories).catch(() => ({
            files: [],
            truncated: true,
          }))
        : { files: [], truncated: false }),
      warnings: [
        ...(this.unavailable.has(file)
          ? [
              "Could not store default branch metadata. Check repository cache permissions.",
            ]
          : []),
        ...(cached?.warning ? [cached.warning] : []),
      ],
      refreshing,
      updatedAt: cached?.updatedAt ?? null,
    };
  }
}
