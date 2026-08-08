import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { readdir, unlink } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatBytes } from "./shared/lib/format-bytes.js";
import { runCommand } from "./shared/lib/run-command.js";

/**
 * Local cache for the prebuilt release tarball. Replaces the previous
 * `gh release download` path so the runtime can fetch a target release
 * artifact over plain HTTPS without requiring the GitHub CLI to be
 * authenticated. The cache lives in `~/.dispatch/cache/` and is keyed by
 * tag, which is immutable on GitHub — once a tarball is downloaded for a
 * tag it stays valid forever, and pruning is just "delete every cached
 * tarball that isn't ahead of the current install."
 *
 * The same cached file is used twice in the assisted-update flow (CRU-146):
 *   1. On "Check for Updates" the runtime extracts only `update-migrations/`
 *      from it to determine whether assisted update is required.
 *   2. On the actual deploy the same tarball is extracted into the install
 *      directory — no second download.
 */

export const RELEASE_ARTIFACT_NAME = "dispatch-release.tar.gz";

// Resolved per call so tests can rebind the env var between runs without
// reloading the module. Production hosts only set the env var at boot, so
// the lookup cost is negligible.
function cacheDir(): string {
  return (
    process.env.DISPATCH_RELEASE_CACHE_DIR ??
    path.join(os.homedir(), ".dispatch", "cache")
  );
}

export type DownloadProgress = (info: {
  message: string;
  bytesReceived?: number;
  totalBytes?: number | null;
}) => void;

export type CachedReleaseTarball = {
  tag: string;
  path: string;
  bytes: number;
};

/**
 * Resolve the cache path for a given tag. The path is deterministic so the
 * deploy step can probe the cache before falling back to a download.
 */
export function cachedTarballPath(tag: string): string {
  return path.join(cacheDir(), `release-${sanitizeTag(tag)}.tar.gz`);
}

/**
 * Returns the cached tarball if one is present for `tag`, or null when the
 * cache is empty / corrupt. Never throws.
 */
export async function readCachedTarball(
  tag: string
): Promise<CachedReleaseTarball | null> {
  const filePath = cachedTarballPath(tag);
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) return null;
    return { tag, path: filePath, bytes: info.size };
  } catch {
    return null;
  }
}

/**
 * Per-tag in-flight download promises. `release/info` polls, `release/update`
 * gate evaluation, and `release/assisted/launch` can all call
 * `ensureCachedTarball` for the same tag concurrently. Without coalescing,
 * each one races on the same `<final>.partial` path and an `rm` from one
 * caller can blow away another caller's in-flight download. A singleflight
 * map keyed by tag collapses concurrent calls into one download; everyone
 * else awaits the same promise. Per-caller random partial filenames are
 * defense-in-depth so a stray rm can't corrupt an in-flight write even if
 * two processes (or a future multi-process arrangement) bypass the map.
 */
const inflightDownloads = new Map<string, Promise<CachedReleaseTarball>>();

/**
 * Ensure a release tarball for `tag` is on disk in the cache. Downloads it
 * if missing. Idempotent and concurrency-safe — concurrent callers for the
 * same tag share one download.
 */
export async function ensureCachedTarball(input: {
  tag: string;
  repo: string;
  onProgress?: DownloadProgress;
}): Promise<CachedReleaseTarball> {
  const { tag, repo, onProgress } = input;
  const existing = await readCachedTarball(tag);
  if (existing) {
    onProgress?.({ message: `cached ${RELEASE_ARTIFACT_NAME} for ${tag}` });
    return existing;
  }

  // If a download is already in flight for this tag, wait on it. The
  // first caller's progress hook gets the byte counts; subsequent
  // callers just see the final result. That's fine: the UI render is
  // gated on the cache file existing, not on per-caller progress.
  const inflight = inflightDownloads.get(tag);
  if (inflight) {
    onProgress?.({
      message: `awaiting in-flight download of ${RELEASE_ARTIFACT_NAME} for ${tag}`,
    });
    return inflight;
  }

  const downloadPromise = (async () => {
    await mkdir(cacheDir(), { recursive: true });
    // Best-effort sweep: if a previous server process exited between
    // createWriteStream and rename, an orphan `.partial.<pid>.<rand>`
    // is sitting in the cache dir. The new pid won't reuse the name,
    // but the file would still leak forever otherwise.
    await sweepOrphanPartials();
    const finalPath = cachedTarballPath(tag);
    // Per-caller partial filename so two writers can never trip over the
    // same path. The atomic-rename below adopts the first one to finish;
    // any later partial files are unlinked on success.
    const partialPath = `${finalPath}.partial.${process.pid}.${randomBytes(4).toString("hex")}`;

    const url = releaseDownloadUrl(repo, tag);
    onProgress?.({ message: `==> downloading ${url}` });

    try {
      await downloadToFile({
        url,
        destination: partialPath,
        onProgress: (bytes, totalBytes) => {
          onProgress?.({
            message: `downloaded ${formatBytes(bytes, { compact: true })}`,
            bytesReceived: bytes,
            totalBytes,
          });
        },
      });
    } catch (err) {
      await rm(partialPath, { force: true }).catch(() => {});
      throw err;
    }

    // Atomic-publish the cache entry. If another writer beat us to it
    // (two callers somehow bypassed the inflight map), rename will
    // overwrite their published file with ours — both came from the
    // same upstream URL and verified Content-Length, so the overwrite
    // is content-identical and harmless.
    await rename(partialPath, finalPath);

    const info = await stat(finalPath);
    return { tag, path: finalPath, bytes: info.size };
  })();

  inflightDownloads.set(tag, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    // Clear the entry on both success AND failure. On failure the next
    // caller gets a fresh attempt rather than re-awaiting the rejected
    // promise; on success the cache file is canonical and future calls
    // hit the readCachedTarball fast path before reaching this map.
    inflightDownloads.delete(tag);
  }
}

/**
 * Drop the cached tarball for a given tag. Used when a cached file fails
 * subsequent integrity checks (e.g. `tar tzf` rejects it as corrupt) so
 * the next call re-downloads instead of looping on the bad artifact.
 */
export async function unlinkCachedTarball(tag: string): Promise<void> {
  await unlink(cachedTarballPath(tag)).catch(() => {});
}

/**
 * Extract `update-migrations/` from a cached tarball into a fresh temp
 * directory. The bulk of the tarball (Bun binaries, web dist) stays inside
 * the cache file — only the migration manifests hit the temp dir. Caller is
 * responsible for cleanup.
 *
 * If `tar tzf` rejects the file as corrupt the cache entry is unlinked
 * before re-throwing — otherwise the next call would re-use the bad
 * tarball, fail the same way, and the only path forward would be a manual
 * `rm ~/.dispatch/cache/release-*.tar.gz`. Re-downloading on the next
 * attempt is the right recovery for a corrupt artifact.
 */
export async function extractUpdateMigrationsTo(
  tarballPath: string
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-migrations-"));
  // Best-effort path-traversal guard mirroring deployFromArtifact: list
  // first, refuse anything with `..` or absolute paths under the
  // update-migrations/ prefix.
  let listing: Awaited<ReturnType<typeof runCommand>>;
  try {
    listing = await runCommand("tar", ["tzf", tarballPath]);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await unlink(tarballPath).catch(() => {});
    throw err instanceof Error
      ? new Error(
          `Failed to read tarball at ${tarballPath} (cache entry removed): ${err.message}`
        )
      : err;
  }
  const unsafeEntries = listing.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => entry.startsWith("/") || entry.includes("../"));
  if (unsafeEntries.length > 0) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Release tarball contains unsafe paths: ${unsafeEntries.slice(0, 5).join(", ")}`
    );
  }
  const hasMigrations = listing.stdout
    .split("\n")
    .some((entry) => entry.startsWith("update-migrations/"));
  if (!hasMigrations) {
    return {
      dir: path.join(tmpDir, "update-migrations"),
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  try {
    await runCommand("tar", [
      "xzf",
      tarballPath,
      "--no-same-owner",
      "-C",
      tmpDir,
      "update-migrations",
    ]);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await unlink(tarballPath).catch(() => {});
    throw err;
  }

  return {
    dir: path.join(tmpDir, "update-migrations"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Read every file under `update-migrations/` inside a tarball into memory.
 * Useful for cheap inspection passes that don't need a temp dir on disk —
 * but we still go through tar so the streaming/path-safety story matches
 * `extractUpdateMigrationsTo`.
 */
export async function readMigrationsFromTarball(
  tarballPath: string
): Promise<Array<{ filename: string; contents: string }>> {
  const { dir, cleanup } = await extractUpdateMigrationsTo(tarballPath);
  try {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const files: Array<{ filename: string; contents: string }> = [];
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      const stats = await stat(filePath).catch(() => null);
      if (!stats || !stats.isFile()) continue;
      const contents = await readFile(filePath, "utf-8");
      files.push({ filename: entry, contents });
    }
    return files;
  } finally {
    await cleanup();
  }
}

/**
 * Pattern for orphan partial-download files. ensureCachedTarball mints
 * one per call as `<final>.partial.<pid>.<rand>` and unlinks it on the
 * local error path, but a hard process exit between createWriteStream and
 * rename leaves the file behind. Sweep them on prune so the cache
 * directory doesn't grow unbounded across crashed deploys.
 */
const PARTIAL_FILE_RE = /^release-.+\.tar\.gz\.partial\..+$/;

/**
 * Drop cached tarballs for tags the install no longer needs. Keeps the
 * cache for `tagsToKeep` (typically the current tag and any "ahead"
 * targets). Also sweeps any orphan `.partial.*` files left behind by
 * crashed downloads. Best-effort — disk errors are swallowed so a deploy
 * never fails because cleanup did.
 */
export async function pruneCacheExcept(
  tagsToKeep: ReadonlyArray<string>
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir());
  } catch {
    return;
  }
  const keep = new Set(
    tagsToKeep.map((tag) => `release-${sanitizeTag(tag)}.tar.gz`)
  );
  for (const entry of entries) {
    const isCanonical =
      entry.startsWith("release-") && entry.endsWith(".tar.gz");
    const isOrphanPartial = PARTIAL_FILE_RE.test(entry);
    if (!isCanonical && !isOrphanPartial) continue;
    if (isCanonical && keep.has(entry)) continue;
    await unlink(path.join(cacheDir(), entry)).catch(() => {});
  }
}

/**
 * Sweep orphan `.partial.*` files that don't belong to an in-flight
 * download in this process. Runs at the start of `ensureCachedTarball`
 * so a long-running server gradually reclaims disk after crashed
 * downloads even if `pruneCacheExcept` isn't called.
 */
async function sweepOrphanPartials(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!PARTIAL_FILE_RE.test(entry)) continue;
    await unlink(path.join(cacheDir(), entry)).catch(() => {});
  }
}

export function releaseDownloadUrl(repo: string, tag: string): string {
  // GitHub serves a deterministic public URL for release assets; this
  // path is what `gh release download` resolves to under the hood. Public
  // repos return the file directly; private repos 302 to a signed S3 URL
  // that requires authentication, which the runtime doesn't have today.
  // That's acceptable for v1 — Dispatch is currently distributed from a
  // public release. When private deploys come online we can layer a
  // GH_TOKEN-bearing fetch on top.
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(
    tag
  )}/${RELEASE_ARTIFACT_NAME}`;
}

async function downloadToFile(input: {
  url: string;
  destination: string;
  onProgress?: (bytesReceived: number, totalBytes: number | null) => void;
}): Promise<{ totalBytes: number | null }> {
  const { url, destination, onProgress } = input;
  const { stream, totalBytes } = await openHttpsStream(url);
  let received = 0;
  let lastReportedAt = 0;
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastReportedAt > 250) {
      lastReportedAt = now;
      onProgress?.(received, totalBytes);
    }
  });
  await pipeline(stream, createWriteStream(destination));
  onProgress?.(received, totalBytes);

  // pipeline() resolves on a clean upstream FIN — but a hung-up-mid-body
  // response is also "clean" from Node's stream perspective when the body
  // is chunked or when the connection drops without the writable seeing
  // an error. If the server told us how many bytes to expect, refuse to
  // accept anything else: a truncated cache file would be reused forever
  // (cache reuse is "size > 0", and we don't checksum the artifact).
  if (totalBytes !== null && received !== totalBytes) {
    throw new Error(
      `Truncated download from ${url}: received ${received} bytes, expected ${totalBytes}`
    );
  }
  return { totalBytes };
}

/**
 * Hosts we'll follow a redirect to. The release-asset URL starts at
 * `github.com` and 302s to `objects.githubusercontent.com` (signed S3
 * frontend). Anything outside this allowlist is treated as a hostile
 * redirect and rejected — without a checksum on the tarball, an attacker
 * who could redirect us to an arbitrary HTTPS host could feed us their
 * artifact. Defense-in-depth.
 */
const ALLOWED_REDIRECT_HOSTS: ReadonlyArray<string | RegExp> = [
  "github.com",
  /\.githubusercontent\.com$/,
  /\.github\.com$/,
];

const DOWNLOAD_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Exported for testability. Production callers go through `openHttpsStream`,
 * which calls this on every redirect hop.
 */
export function isAllowedRedirectHost(host: string): boolean {
  return ALLOWED_REDIRECT_HOSTS.some((pat) =>
    typeof pat === "string" ? host === pat : pat.test(host)
  );
}

async function openHttpsStream(
  url: string,
  redirectsRemaining = 5
): Promise<{ stream: Readable; totalBytes: number | null }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "dispatch-update-client",
          Accept: "application/octet-stream",
        },
        timeout: DOWNLOAD_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          // GitHub redirects the public release-asset URL to a signed S3
          // URL. Follow the redirect with a fresh request — node:https
          // doesn't auto-follow.
          if (redirectsRemaining <= 0) {
            res.resume();
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            res.resume();
            reject(
              new Error(
                `Invalid redirect target from ${url}: ${String(res.headers.location)}`
              )
            );
            return;
          }
          if (nextUrl.protocol !== "https:") {
            res.resume();
            reject(
              new Error(
                `Refusing non-https redirect from ${url} to ${nextUrl.toString()}`
              )
            );
            return;
          }
          if (!isAllowedRedirectHost(nextUrl.hostname)) {
            res.resume();
            reject(
              new Error(
                `Refusing redirect from ${url} to disallowed host ${nextUrl.hostname}`
              )
            );
            return;
          }
          res.resume();
          openHttpsStream(nextUrl.toString(), redirectsRemaining - 1).then(
            resolve,
            reject
          );
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Failed to download ${url}: HTTP ${status}`));
          return;
        }
        const lengthHeader = res.headers["content-length"];
        const totalBytes =
          typeof lengthHeader === "string"
            ? Number(lengthHeader) || null
            : null;
        resolve({ stream: res, totalBytes });
      }
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Request timed out after ${DOWNLOAD_REQUEST_TIMEOUT_MS}ms fetching ${url}`
        )
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function sanitizeTag(tag: string): string {
  // Tags from the release flow look like `v0.18.13`, but be defensive: a
  // future release tag could include characters that would escape the cache
  // dir (e.g. "../../etc/passwd"). Replace anything outside [A-Za-z0-9._-]
  return tag.replace(/[^A-Za-z0-9._-]/g, "_");
}
