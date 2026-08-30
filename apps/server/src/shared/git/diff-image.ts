import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { DIFF_IMAGE_MAX_BYTES, type DiffImageInfo } from "@dispatch/shared";

import { isImageFile } from "../media-file-types.js";
import { runCommand, type CommandRunner } from "../lib/run-command.js";

export { isImageFile };

const GIT_TIMEOUT_MS = 15_000;

export type ImageSide = "old" | "new";

/** The four extensions the Changes pane previews, mapped to what it serves. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME[ext] ?? null;
}

/**
 * Byte size of every requested path in a tree, keyed by path.
 *
 * `ls-tree -l` takes many pathspecs at once, so one call covers a whole diff's
 * worth of images; paths absent from the tree simply don't come back, which is
 * exactly the "did not exist on this side" answer the caller wants.
 */
async function treeBlobSizes(
  worktreePath: string,
  ref: string,
  paths: string[],
  run: CommandRunner
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
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
    sizes.set(record.slice(tabIndex + 1), size);
  }
  return sizes;
}

async function worktreeFileSize(
  worktreePath: string,
  filePath: string
): Promise<number | null> {
  const resolved = resolveInsideWorktree(worktreePath, filePath);
  if (!resolved) return null;
  try {
    const info = await lstat(resolved);
    return info.isFile() ? info.size : null;
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
    treeBlobSizes(worktreePath, mergeBaseSha, oldPaths, run),
    options.includeUncommitted
      ? Promise.resolve(new Map<string, number>())
      : treeBlobSizes(worktreePath, "HEAD", newPaths, run),
  ]);

  for (const entry of entries) {
    const oldSize =
      entry.status === "added"
        ? null
        : (oldSizes.get(entry.oldPath ?? entry.path) ?? null);
    let newSize: number | null = null;
    if (entry.status !== "deleted") {
      newSize = options.includeUncommitted
        ? await worktreeFileSize(worktreePath, entry.path)
        : (headSizes.get(entry.path) ?? null);
    }
    info.set(entry.path, { oldSize, newSize });
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
    try {
      const info = await lstat(resolved);
      if (!info.isFile()) return { ok: false, reason: "not-found" };
      if (info.size > DIFF_IMAGE_MAX_BYTES) {
        return { ok: false, reason: "too-large" };
      }
      return { ok: true, buffer: await readFile(resolved), contentType };
    } catch {
      return { ok: false, reason: "not-found" };
    }
  }

  const buffer = await gitShowBinary(worktreePath, `${ref}:${filePath}`);
  if (buffer === "too-large") return { ok: false, reason: "too-large" };
  if (!buffer) return { ok: false, reason: "not-found" };
  return { ok: true, buffer, contentType };
}

function gitShowBinary(
  worktreePath: string,
  spec: string
): Promise<Buffer | null | "too-large"> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", worktreePath, "show", spec], {
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
