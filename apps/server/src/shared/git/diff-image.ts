import { spawn } from "node:child_process";
import { openRegularFile } from "../../files/open-workspace-file.js";
import { realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { childProcessEnv } from "../process/child-environment.js";

import { DIFF_IMAGE_MAX_BYTES, type DiffImageInfo } from "@dispatch/shared";

import { imageMimeType, isImageFile } from "@dispatch/runner-protocol";
export { imageMimeType, isImageFile } from "@dispatch/runner-protocol";
import { resolveBaseRef } from "./base-ref.js";
import { runCommand, type CommandRunner } from "../lib/run-command.js";

const GIT_TIMEOUT_MS = 15_000;

export type ImageSide = "old" | "new";

/**
 * Byte size of every requested path in a tree, keyed by path.
 *
 * `ls-tree -l` takes many pathspecs at once, so one call covers a whole diff's
 * worth of images; paths absent from the tree simply don't come back, which is
 * exactly the "did not exist on this side" answer the caller wants.
 */
type ImageVersion = { size: number };
async function treeImages(
  worktreePath: string,
  ref: string,
  paths: string[],
  run: CommandRunner
): Promise<Map<string, ImageVersion>> {
  const sizes = new Map<string, ImageVersion>();
  if (paths.length === 0) return sizes;
  const result = await run(
    "git",
    ["-C", worktreePath, "ls-tree", "-l", "-z", ref, "--", ...paths],
    { allowedExitCodes: [0, 128], timeoutMs: GIT_TIMEOUT_MS }
  );
  if (result.exitCode !== 0) return sizes;
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) continue;
    const meta = record.slice(0, tabIndex).trim().split(/\s+/);
    const size = Number.parseInt(meta[3] ?? "", 10);
    if (!Number.isFinite(size)) continue;
    sizes.set(record.slice(tabIndex + 1), { size });
  }
  return sizes;
}

async function worktreeImageVersion(
  worktreePath: string,
  filePath: string
): Promise<ImageVersion | null> {
  const resolved = resolveInsideWorktree(worktreePath, filePath);
  if (!resolved) return null;
  try {
    const handle = await openRegularFile(
      await realpath(worktreePath),
      path.relative(worktreePath, resolved).split(path.sep)
    );
    try {
      const info = await handle.stat();
      return info.isFile() ? { size: info.size } : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function resolveInsideWorktree(
  worktreePath: string,
  filePath: string
): string | null {
  const root = path.resolve(worktreePath);
  const full = path.resolve(root, filePath);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export type ImageSizeRequest = {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
};

/**
 * Fill in `DiffFile.image` for the image paths in a diff.
 *
 * The old side always comes from the merge base's tree. The new side comes
 * from the working tree when uncommitted changes are in scope (that is the
 * file the user is looking at) and from HEAD's tree otherwise, which keeps the
 * sizes consistent with the diff range the rest of the response was built for.
 */
export async function collectImageInfo(
  worktreePath: string,
  mergeBaseSha: string,
  entries: ImageSizeRequest[],
  options: { includeUncommitted: boolean },
  run: CommandRunner = runCommand
): Promise<Map<string, DiffImageInfo>> {
  const info = new Map<string, DiffImageInfo>();
  if (entries.length === 0) return info;

  const oldPaths = entries
    .filter((e) => e.status !== "added")
    .map((e) => e.oldPath ?? e.path);
  const newPaths = entries
    .filter((e) => e.status !== "deleted")
    .map((e) => e.path);

  const [oldSizes, headSizes] = await Promise.all([
    treeImages(worktreePath, mergeBaseSha, oldPaths, run),
    options.includeUncommitted
      ? Promise.resolve(new Map<string, ImageVersion>())
      : treeImages(worktreePath, "HEAD", newPaths, run),
  ]);

  for (const entry of entries) {
    const oldSide =
      entry.status === "added"
        ? null
        : (oldSizes.get(entry.oldPath ?? entry.path) ?? null);
    let newSide: ImageVersion | null = null;
    if (entry.status !== "deleted") {
      newSide = options.includeUncommitted
        ? await worktreeImageVersion(worktreePath, entry.path)
        : (headSizes.get(entry.path) ?? null);
    }
    info.set(entry.path, {
      oldSize: oldSide?.size ?? null,
      newSize: newSide?.size ?? null,
    });
  }

  return info;
}

export type ImageBytesResult =
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; reason: "not-found" | "too-large" };

/**
 * Read one side of an image change as bytes.
 *
 * `git show` output is binary, so this spawns directly instead of going
 * through `runCommand`, which decodes stdout as a string. Output is capped at
 * the shared preview limit and the child is killed the moment it goes over,
 * so a mistakenly-named 2 GB file cannot buffer into the API process.
 */
export async function readImageSide(
  worktreePath: string,
  ref: string,
  filePath: string,
  fromWorktree: boolean
): Promise<ImageBytesResult> {
  const contentType = imageMimeType(filePath);
  if (!contentType) return { ok: false, reason: "not-found" };

  if (fromWorktree) {
    const resolved = resolveInsideWorktree(worktreePath, filePath);
    if (!resolved) return { ok: false, reason: "not-found" };
    return await readWorktreeImage(worktreePath, resolved, contentType);
  }

  const buffer = await gitShowBinary(worktreePath, `${ref}:${filePath}`);
  if (buffer === "too-large") return { ok: false, reason: "too-large" };
  if (!buffer) return { ok: false, reason: "not-found" };
  return { ok: true, buffer, contentType };
}

/**
 * Read a working-tree image through a single file handle.
 *
 * Opening with O_NOFOLLOW and then stat-ing and reading *that handle* keeps
 * the symlink check, the size check and the read on one descriptor. The
 * path-based lstat-then-readFile pair it replaces could be raced by anything
 * writing in the worktree — the agent whose diff this is, most obviously —
 * swapping the checked file for a symlink or a much larger one between the
 * two calls, which would read past both the containment check and the cap.
 */
async function readWorktreeImage(
  root: string,
  fullPath: string,
  contentType: string
): Promise<ImageBytesResult> {
  let handle: FileHandle | null = null;
  try {
    handle = await openRegularFile(
      await realpath(root),
      path.relative(root, fullPath).split(path.sep)
    );
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-found" };
    if (info.size > DIFF_IMAGE_MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        info.size - read,
        read
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return {
      ok: true,
      buffer: read === info.size ? buffer : buffer.subarray(0, read),
      contentType,
    };
  } catch {
    return { ok: false, reason: "not-found" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function gitShowBinary(
  worktreePath: string,
  spec: string
): Promise<Buffer | null | "too-large"> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", worktreePath, "show", spec], {
      env: childProcessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Buffer | null | "too-large"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > DIFF_IMAGE_MAX_BYTES) {
        child.kill("SIGKILL");
        finish("too-large");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      finish(code === 0 ? Buffer.concat(chunks) : null);
    });
  });
}

/**
 * Read one side of an image change, resolving the diff range the same way
 * `getAgentDiff` does.
 *
 * The route calls this rather than resolving the base ref itself, so the bytes
 * served always come from the revision the diff metadata was computed against
 * — the two cannot drift apart when the base-selection policy changes.
 */
export async function getAgentDiffImage(
  worktreePath: string,
  baseRef: string | null,
  filePath: string,
  side: ImageSide,
  options: { includeUncommitted: boolean },
  run: CommandRunner = runCommand
): Promise<ImageBytesResult> {
  if (!isImageFile(filePath)) return { ok: false, reason: "not-found" };

  const resolvedBase = await resolveBaseRef(worktreePath, baseRef, {
    runCommand: run,
  });
  const mergeBaseResult = resolvedBase
    ? await run(
        "git",
        ["-C", worktreePath, "merge-base", "HEAD", resolvedBase],
        { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
      )
    : null;
  const mergeBaseSha =
    mergeBaseResult?.exitCode === 0 ? mergeBaseResult.stdout.trim() : "";

  if (side === "old") {
    if (!mergeBaseSha) return { ok: false, reason: "not-found" };
    return await readImageSide(worktreePath, mergeBaseSha, filePath, false);
  }

  // The new side is whatever the diff was computed against: the file on disk
  // when uncommitted work is in scope, HEAD's blob when it is not.
  return await readImageSide(
    worktreePath,
    "HEAD",
    filePath,
    options.includeUncommitted
  );
}
