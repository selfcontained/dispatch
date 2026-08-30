import {
  mkdtemp,
  rm,
  mkdir,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DIFF_IMAGE_MAX_BYTES } from "@dispatch/shared";

import { getAgentDiff } from "../src/shared/git/agent-diff.js";
import {
  collectImageInfo,
  getAgentDiffImage,
  imageMimeType,
  isImageFile,
  readImageSide,
  resolveInsideWorktree,
} from "../src/shared/git/diff-image.js";
import { runCommand } from "../src/shared/lib/run-command.js";

/**
 * These run against a real repository on purpose: everything under test reads
 * git's own output formats (`ls-tree -l -z`, `show`'s binary stdout), which a
 * mocked runner would only re-assert back at itself.
 */
function png(width: number, height: number, rgb: [number, number, number]) {
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb))),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let repo: string;
let mergeBase: string;

const git = async (...args: string[]): Promise<string> => {
  const result = await runCommand("git", ["-C", repo, ...args], {
    allowedExitCodes: [0],
  });
  return result.stdout.trim();
};

beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "diff-image-test-"));
  await runCommand("git", ["-C", repo, "init", "-q", "-b", "main"]);
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await mkdir(path.join(repo, "assets"), { recursive: true });
  await writeFile(path.join(repo, "assets/logo.png"), png(4, 4, [10, 20, 30]));
  await writeFile(path.join(repo, "assets/gone.png"), png(2, 2, [1, 2, 3]));
  await git("add", "-A");
  await git("commit", "-qm", "base");
  mergeBase = await git("rev-parse", "HEAD");

  await git("checkout", "-q", "-b", "feature");
  await writeFile(path.join(repo, "assets/logo.png"), png(8, 8, [200, 30, 30]));
  await writeFile(path.join(repo, "assets/added.png"), png(6, 6, [0, 200, 0]));
  await unlink(path.join(repo, "assets/gone.png"));
  await git("add", "-A");
  await git("commit", "-qm", "image changes");
  await writeFile(
    path.join(repo, "assets/untracked.png"),
    png(3, 3, [5, 5, 200])
  );
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("isImageFile", () => {
  it("accepts the raster formats the media uploader accepts", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp"]) {
      expect(isImageFile(name)).toBe(true);
    }
  });

  it("rejects svg and non-images so they keep their textual diff", () => {
    for (const name of ["icon.svg", "notes.md", "a.png.txt", "noext"]) {
      expect(isImageFile(name)).toBe(false);
    }
  });
});

describe("getAgentDiff image metadata", () => {
  it("attaches sizes for added, modified, deleted and untracked images", async () => {
    const result = await getAgentDiff(repo, "main");
    expect(result).not.toBeNull();
    const byPath = new Map(result!.files.map((f) => [f.path, f]));

    const modified = byPath.get("assets/logo.png")!;
    expect(modified.status).toBe("modified");
    expect(modified.image?.oldSize).toBeGreaterThan(0);
    expect(modified.image?.newSize).toBeGreaterThan(0);
    expect(modified.image!.newSize).not.toBe(modified.image!.oldSize);

    const added = byPath.get("assets/added.png")!;
    expect(added.image).toEqual({
      oldSize: null,
      newSize: expect.any(Number),
    });

    const deleted = byPath.get("assets/gone.png")!;
    expect(deleted.image).toEqual({
      oldSize: expect.any(Number),
      newSize: null,
    });

    // Untracked binaries carry no textual diff, so `image` is the only thing
    // that lets the client render them as anything but a placeholder.
    const untracked = byPath.get("assets/untracked.png")!;
    expect(untracked.diff).toBeNull();
    expect(untracked.image?.newSize).toBeGreaterThan(0);
  });

  it("leaves non-image files without image metadata", async () => {
    const result = await getAgentDiff(repo, "main");
    for (const file of result!.files) {
      if (!isImageFile(file.path)) expect(file.image).toBeUndefined();
    }
  });
});

describe("collectImageInfo", () => {
  it("reads the old side from the merge base, not the working tree", async () => {
    const info = await collectImageInfo(
      repo,
      mergeBase,
      [{ path: "assets/logo.png", status: "modified" }],
      { includeUncommitted: true }
    );
    const entry = info.get("assets/logo.png")!;
    const oldBytes = await readImageSide(
      repo,
      mergeBase,
      "assets/logo.png",
      false
    );
    expect(oldBytes.ok).toBe(true);
    expect(entry.oldSize).toBe(
      oldBytes.ok ? oldBytes.buffer.byteLength : undefined
    );
  });

  it("follows the rename's old path when sizing the base side", async () => {
    const info = await collectImageInfo(
      repo,
      mergeBase,
      [
        {
          path: "assets/renamed.png",
          oldPath: "assets/logo.png",
          status: "renamed",
        },
      ],
      { includeUncommitted: true }
    );
    expect(info.get("assets/renamed.png")!.oldSize).toBeGreaterThan(0);
  });
});

describe("readImageSide", () => {
  it("returns PNG bytes for the base blob and the working-tree file", async () => {
    const oldSide = await readImageSide(
      repo,
      mergeBase,
      "assets/logo.png",
      false
    );
    const newSide = await readImageSide(repo, "HEAD", "assets/logo.png", true);
    expect(oldSide.ok && newSide.ok).toBe(true);
    if (!oldSide.ok || !newSide.ok) return;
    expect(oldSide.contentType).toBe("image/png");
    expect(oldSide.buffer.subarray(1, 4).toString()).toBe("PNG");
    expect(newSide.buffer.equals(oldSide.buffer)).toBe(false);
  });

  it("reports not-found for a path missing on the requested side", async () => {
    const result = await readImageSide(
      repo,
      mergeBase,
      "assets/added.png",
      false
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a path that escapes the worktree", async () => {
    expect(resolveInsideWorktree(repo, "../escape.png")).toBeNull();
    const result = await readImageSide(repo, "HEAD", "../escape.png", true);
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a symlink at the path even when its target is a real image", async () => {
    const target = path.join(repo, "assets/added.png");
    const link = path.join(repo, "assets/linked.png");
    await symlink(target, link);
    try {
      // O_NOFOLLOW is what makes this deterministic: the check and the read
      // share one descriptor, so there is no window in which the path could
      // become a symlink after being approved as a regular file.
      const result = await readImageSide(
        repo,
        "HEAD",
        "assets/linked.png",
        true
      );
      expect(result).toEqual({ ok: false, reason: "not-found" });
    } finally {
      await unlink(link);
    }
  });

  it("refuses a working-tree file over the preview cap", async () => {
    const big = path.join(repo, "assets/huge.png");
    await writeFile(big, Buffer.alloc(DIFF_IMAGE_MAX_BYTES + 1));
    try {
      const result = await readImageSide(repo, "HEAD", "assets/huge.png", true);
      expect(result).toEqual({ ok: false, reason: "too-large" });
    } finally {
      await unlink(big);
    }
  });

  it("refuses a non-image extension even when the file exists", async () => {
    expect(imageMimeType("notes.md")).toBeNull();
    const result = await readImageSide(repo, "HEAD", "notes.md", true);
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("getAgentDiffImage", () => {
  it("serves the merge-base blob for old and the working tree for new", async () => {
    const oldSide = await getAgentDiffImage(
      repo,
      "main",
      "assets/logo.png",
      "old",
      { includeUncommitted: true }
    );
    const newSide = await getAgentDiffImage(
      repo,
      "main",
      "assets/logo.png",
      "new",
      { includeUncommitted: true }
    );
    expect(oldSide.ok && newSide.ok).toBe(true);
    if (!oldSide.ok || !newSide.ok) return;
    expect(oldSide.contentType).toBe("image/png");
    expect(newSide.buffer.equals(oldSide.buffer)).toBe(false);

    // The old side must be the base revision, not the file on disk.
    const onDisk = await readFile(path.join(repo, "assets/logo.png"));
    expect(newSide.buffer.equals(onDisk)).toBe(true);
    expect(oldSide.buffer.equals(onDisk)).toBe(false);
  });

  it("refuses a non-image path before touching git", async () => {
    const result = await getAgentDiffImage(repo, "main", "README.md", "new", {
      includeUncommitted: true,
    });
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});
