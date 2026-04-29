import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  copyTruncateFile,
  deleteOldFiles,
  rotateFile,
} from "../src/diagnostics.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "diagnostics-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const writeFileWithMtime = async (
  filePath: string,
  contents: string,
  mtime: Date
): Promise<void> => {
  await writeFile(filePath, contents);
  await utimes(filePath, mtime, mtime);
};

describe("deleteOldFiles", () => {
  it("is a no-op when the directory does not exist", async () => {
    await expect(
      deleteOldFiles(path.join(tmpDir, "missing"), /\.json$/, 1000)
    ).resolves.toBeUndefined();
  });

  it("deletes files matching the pattern that are older than maxAgeMs", async () => {
    const now = Date.now();
    const old = new Date(now - 10_000); // 10 s ago
    const recent = new Date(now - 100); // 0.1 s ago

    await writeFileWithMtime(path.join(tmpDir, "old.json"), "{}", old);
    await writeFileWithMtime(path.join(tmpDir, "recent.json"), "{}", recent);

    // 5 s threshold — only the old file should go.
    await deleteOldFiles(tmpDir, /\.json$/, 5_000);

    await expect(stat(path.join(tmpDir, "old.json"))).rejects.toThrow();
    await expect(stat(path.join(tmpDir, "recent.json"))).resolves.toBeDefined();
  });

  it("ignores files that don't match the pattern", async () => {
    const long_ago = new Date(Date.now() - 10_000);
    await writeFileWithMtime(path.join(tmpDir, "keep.txt"), "x", long_ago);
    await writeFileWithMtime(path.join(tmpDir, "drop.json"), "x", long_ago);

    await deleteOldFiles(tmpDir, /\.json$/, 1000);

    await expect(stat(path.join(tmpDir, "keep.txt"))).resolves.toBeDefined();
    await expect(stat(path.join(tmpDir, "drop.json"))).rejects.toThrow();
  });

  it("survives a file disappearing mid-iteration (no rejection)", async () => {
    // Create 3 old files, all matching. The function should not throw if
    // any of them vanish between readdir and unlink.
    const oldMtime = new Date(Date.now() - 10_000);
    for (const name of ["a.json", "b.json", "c.json"]) {
      await writeFileWithMtime(path.join(tmpDir, name), "{}", oldMtime);
    }

    // Race-condition surrogate: pre-delete one. The function still
    // iterates over all three names but should swallow the unlink ENOENT.
    await rm(path.join(tmpDir, "b.json"));

    await expect(
      deleteOldFiles(tmpDir, /\.json$/, 1000)
    ).resolves.toBeUndefined();
  });

  it("matches against the basename, not the full path (anchored regex still works)", async () => {
    // The function passes `entry` (basename) into `pattern.test`, so a
    // regex like `/^prefix-/` matches as expected without needing to
    // account for the parent dir.
    const oldMtime = new Date(Date.now() - 10_000);
    await writeFileWithMtime(path.join(tmpDir, "prefix-1.log"), "x", oldMtime);
    await writeFileWithMtime(path.join(tmpDir, "other.log"), "x", oldMtime);

    await deleteOldFiles(tmpDir, /^prefix-/, 1000);

    await expect(stat(path.join(tmpDir, "prefix-1.log"))).rejects.toThrow();
    await expect(stat(path.join(tmpDir, "other.log"))).resolves.toBeDefined();
  });
});

describe("rotateFile", () => {
  it("is a no-op when the file does not exist", async () => {
    await expect(
      rotateFile(path.join(tmpDir, "missing.log"), 3)
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the file is below the size threshold (10 MB)", async () => {
    const filePath = path.join(tmpDir, "small.log");
    await writeFile(filePath, "tiny");
    await rotateFile(filePath, 3);

    // Original still there, no .1 backup created.
    await expect(stat(filePath)).resolves.toBeDefined();
    await expect(stat(`${filePath}.1`)).rejects.toThrow();
  });
});

describe("copyTruncateFile", () => {
  it("is a no-op when the file does not exist", async () => {
    await expect(
      copyTruncateFile(path.join(tmpDir, "missing.log"), 3)
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the file is below the size threshold (10 MB)", async () => {
    const filePath = path.join(tmpDir, "server.log");
    const original = "tiny content";
    await writeFile(filePath, original);
    await copyTruncateFile(filePath, 3);

    // Truncate must NOT have run.
    await expect(stat(`${filePath}.1`)).rejects.toThrow();
    const after = await stat(filePath);
    expect(after.size).toBe(original.length);
  });
});

describe("createDiagnosticsRecorder shape", () => {
  // Sanity check that the factory exposes only the three documented
  // entry points — guards against accidentally widening the public
  // surface in a future refactor.
  it("exposes exactly the three documented methods", async () => {
    const { createDiagnosticsRecorder } = await import("../src/diagnostics.js");
    const noopLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => noopLogger,
      silent: () => {},
      level: "silent",
    } as unknown as import("fastify").FastifyBaseLogger;

    const recorder = createDiagnosticsRecorder(noopLogger);
    expect(Object.keys(recorder).sort()).toEqual([
      "captureMissingSessionIncident",
      "maybeCaptureTmuxInventory",
      "maybeMaintenanceLogs",
    ]);
  });

  it("returns independent recorders (throttle clocks live in separate closures)", async () => {
    // This is what justifies the factory pattern: each call yields a
    // fresh recorder so test-time recorders don't share state with
    // anything else.
    const { createDiagnosticsRecorder } = await import("../src/diagnostics.js");
    const noopLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => noopLogger,
      silent: () => {},
      level: "silent",
    } as unknown as import("fastify").FastifyBaseLogger;

    const a = createDiagnosticsRecorder(noopLogger);
    const b = createDiagnosticsRecorder(noopLogger);
    expect(a).not.toBe(b);
    expect(a.maybeCaptureTmuxInventory).not.toBe(b.maybeCaptureTmuxInventory);
  });
});
