import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { readdir, unlink } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

const CACHE_DIR =
  process.env.DISPATCH_RELEASE_CACHE_DIR ??
  path.join(os.homedir(), ".dispatch", "cache");

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
  return path.join(CACHE_DIR, `release-${sanitizeTag(tag)}.tar.gz`);
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
 * Ensure a release tarball for `tag` is on disk in the cache. Downloads it
 * if missing. Idempotent — returns the cached entry without re-downloading
 * when the file is already present.
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

  await mkdir(CACHE_DIR, { recursive: true });
  const finalPath = cachedTarballPath(tag);
  const partialPath = `${finalPath}.partial`;
  // If a previous attempt left a partial behind, remove it so we don't
  // resume into a half-downloaded file with the wrong size.
  await rm(partialPath, { force: true }).catch(() => {});

  const url = releaseDownloadUrl(repo, tag);
  onProgress?.({ message: `==> downloading ${url}` });

  const { totalBytes } = await downloadToFile({
    url,
    destination: partialPath,
    onProgress: (bytes) => {
      onProgress?.({
        message: `downloaded ${formatBytes(bytes)}`,
        bytesReceived: bytes,
        totalBytes,
      });
    },
  });

  // Atomic-publish the cache entry: a partial file must never be observable
  // as the canonical cache. rename() on the same filesystem is atomic.
  await rename(partialPath, finalPath);

  const info = await stat(finalPath);
  return { tag, path: finalPath, bytes: info.size };
}

/**
 * Extract `update-migrations/` from a cached tarball into a fresh temp
 * directory. The bulk of the tarball (Bun binaries, web dist) stays inside
 * the cache file — only the migration manifests hit the temp dir. Caller is
 * responsible for cleanup.
 */
export async function extractUpdateMigrationsTo(
  tarballPath: string
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-migrations-"));
  // Best-effort path-traversal guard mirroring deployFromArtifact: list
  // first, refuse anything with `..` or absolute paths under the
  // update-migrations/ prefix.
  const listing = await runCommand("tar", ["tzf", tarballPath]);
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

  await runCommand("tar", [
    "xzf",
    tarballPath,
    "--no-same-owner",
    "-C",
    tmpDir,
    "update-migrations",
  ]);

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
 * Drop cached tarballs for tags the install no longer needs. Keeps the
 * cache for `tagsToKeep` (typically the current tag and any "ahead"
 * targets). Best-effort — disk errors are swallowed so a deploy never fails
 * because cleanup did.
 */
export async function pruneCacheExcept(
  tagsToKeep: ReadonlyArray<string>
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(CACHE_DIR);
  } catch {
    return;
  }
  const keep = new Set(
    tagsToKeep.map((tag) => `release-${sanitizeTag(tag)}.tar.gz`)
  );
  for (const entry of entries) {
    if (!entry.startsWith("release-") || !entry.endsWith(".tar.gz")) continue;
    if (keep.has(entry)) continue;
    await unlink(path.join(CACHE_DIR, entry)).catch(() => {});
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
  onProgress?: (bytesReceived: number) => void;
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
      onProgress?.(received);
    }
  });
  await pipeline(stream, createWriteStream(destination));
  onProgress?.(received);
  return { totalBytes };
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
          res.resume();
          openHttpsStream(res.headers.location, redirectsRemaining - 1).then(
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
    req.on("error", reject);
    req.end();
  });
}

function sanitizeTag(tag: string): string {
  // Tags from the release flow look like `v0.18.13`, but be defensive: a
  // future release tag could include characters that would escape the cache
  // dir (e.g. "../../etc/passwd"). Replace anything outside [A-Za-z0-9._-]
  // with "_" so the cache filename is always a child of CACHE_DIR.
  return tag.replace(/[^A-Za-z0-9._-]/g, "_");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}
