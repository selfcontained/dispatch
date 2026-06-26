import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  shouldExcludePath,
  looksBinary,
  countLines,
  readUntrackedFile,
} from "../src/shared/git/diff-file-rules.js";

describe("shouldExcludePath", () => {
  it.each([
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "uv.lock",
    "Podfile.lock",
    "Package.resolved",
    "composer.lock",
    "mix.lock",
  ])("excludes %s", (file) => {
    expect(shouldExcludePath(file)).toBe(true);
  });

  it("excludes lock files in subdirectories", () => {
    expect(shouldExcludePath("some/nested/pnpm-lock.yaml")).toBe(true);
    expect(shouldExcludePath("apps/web/package-lock.json")).toBe(true);
  });

  it("does not exclude regular source files", () => {
    expect(shouldExcludePath("src/index.ts")).toBe(false);
    expect(shouldExcludePath("package.json")).toBe(false);
    expect(shouldExcludePath("README.md")).toBe(false);
  });

  it("does not exclude files with lock in the name but not matching exactly", () => {
    expect(shouldExcludePath("lockfile.txt")).toBe(false);
    expect(shouldExcludePath("my-lock.yaml")).toBe(false);
  });
});

describe("looksBinary", () => {
  it("returns false for plain text", () => {
    expect(looksBinary(Buffer.from("hello world\n"))).toBe(false);
  });

  it("returns true when a null byte is present", () => {
    expect(looksBinary(Buffer.from([0x48, 0x00, 0x65]))).toBe(true);
  });

  it("returns true for a null byte at position 0", () => {
    expect(looksBinary(Buffer.from([0x00, 0x41, 0x42]))).toBe(true);
  });

  it("returns false for an empty buffer", () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  it("detects null byte within the 8KB probe window", () => {
    const buf = Buffer.alloc(8192, 0x41);
    buf[8191] = 0x00;
    expect(looksBinary(buf)).toBe(true);
  });

  it("ignores null bytes beyond the 8KB probe window", () => {
    const buf = Buffer.alloc(16384, 0x41);
    buf[8192] = 0x00;
    expect(looksBinary(buf)).toBe(false);
  });

  it("handles utf-8 multibyte characters", () => {
    expect(looksBinary(Buffer.from("こんにちは"))).toBe(false);
  });
});

describe("countLines", () => {
  it("returns 0 for empty string", () => {
    expect(countLines("")).toBe(0);
  });

  it("counts lines with trailing newline", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  it("counts lines without trailing newline", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  it("returns 1 for a single line with newline", () => {
    expect(countLines("hello\n")).toBe(1);
  });

  it("returns 1 for a single line without newline", () => {
    expect(countLines("hello")).toBe(1);
  });

  it("handles multiple blank lines", () => {
    expect(countLines("\n\n\n")).toBe(3);
  });
});

describe("readUntrackedFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "diff-rules-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a small text file and returns content with line count", async () => {
    await writeFile(path.join(tmpDir, "hello.ts"), "line1\nline2\nline3\n");
    const result = await readUntrackedFile(tmpDir, "hello.ts");
    expect(result.lines).toBe(3);
    expect(result.content).toBe("line1\nline2\nline3\n");
  });

  it("blocks path traversal attempts", async () => {
    const result = await readUntrackedFile(tmpDir, "../../../etc/passwd");
    expect(result.lines).toBe(0);
    expect(result.content).toBeNull();
  });

  it("returns null content for nonexistent files", async () => {
    const result = await readUntrackedFile(tmpDir, "nope.ts");
    expect(result.lines).toBe(0);
    expect(result.content).toBeNull();
  });

  it("returns null content for empty files", async () => {
    await writeFile(path.join(tmpDir, "empty.ts"), "");
    const result = await readUntrackedFile(tmpDir, "empty.ts");
    expect(result.lines).toBe(0);
    expect(result.content).toBeNull();
  });

  it("returns null content for binary files", async () => {
    await writeFile(
      path.join(tmpDir, "image.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
    );
    const result = await readUntrackedFile(tmpDir, "image.bin");
    expect(result.lines).toBe(0);
    expect(result.content).toBeNull();
  });

  it("returns null content for files exceeding 1MB", async () => {
    const bigContent = Buffer.alloc(1024 * 1024 + 1, 0x41);
    await writeFile(path.join(tmpDir, "huge.txt"), bigContent);
    const result = await readUntrackedFile(tmpDir, "huge.txt");
    expect(result.lines).toBe(0);
    expect(result.content).toBeNull();
  });

  it("reads files in subdirectories", async () => {
    await mkdir(path.join(tmpDir, "src", "lib"), { recursive: true });
    await writeFile(path.join(tmpDir, "src", "lib", "util.ts"), "export {};\n");
    const result = await readUntrackedFile(tmpDir, "src/lib/util.ts");
    expect(result.lines).toBe(1);
    expect(result.content).toBe("export {};\n");
  });

  it("returns null content for directories", async () => {
    await mkdir(path.join(tmpDir, "subdir"));
    const result = await readUntrackedFile(tmpDir, "subdir");
    expect(result.lines).toBe(0);
    expect(result.content).toBeNull();
  });

  it("returns null content for symlinks", async () => {
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "diff-rules-outside-")
    );
    try {
      await writeFile(path.join(outsideDir, "secret.txt"), "sensitive\n");
      await symlink(
        path.join(outsideDir, "secret.txt"),
        path.join(tmpDir, "link.txt")
      );
      const result = await readUntrackedFile(tmpDir, "link.txt");
      expect(result.lines).toBe(0);
      expect(result.content).toBeNull();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
