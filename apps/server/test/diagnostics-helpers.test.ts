import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  copyTruncateFile,
  createDiagnosticsRecorder,
  serverLogPath,
  deleteOldFiles,
  rotateFile,
} from "../src/diagnostics.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "diagnostics-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  // Sanity check that the factory exposes only the documented
  // entry point — guards against accidentally widening the public
  // surface in a future refactor.
  it("exposes exactly the documented methods", async () => {
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
    expect(Object.keys(recorder).sort()).toEqual(["maybeMaintenanceLogs"]);
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
    expect(a.maybeMaintenanceLogs).not.toBe(b.maybeMaintenanceLogs);
  });
});

const LIMIT = 10 * 1024 * 1024;
const logger = {
  warn: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

describe("managed server log retention", () => {
  it.each([
    ["native Mac", "macos-app", "server.log"],
    ["installer launchd", "", "logs/dispatch.log"],
    ["non-native Linux/manual", "server", "logs/dispatch.log"],
  ])(
    "selects the actual %s path and maintains on the first call",
    async (_name, owner, relative) => {
      vi.stubEnv("DISPATCH_STATE_DIR", tmpDir);
      vi.stubEnv("DISPATCH_UPDATE_OWNER", owner);
      vi.spyOn(Date, "now").mockReturnValue(0);
      const selected = path.join(tmpDir, relative);
      expect(serverLogPath()).toBe(selected);
      await mkdir(path.dirname(selected), { recursive: true });
      await writeFile(selected, Buffer.alloc(LIMIT + 17, "x"));
      // The native and legacy files can coexist; never touch the other one.
      const other =
        relative === "server.log"
          ? path.join(tmpDir, "logs/dispatch.log")
          : path.join(tmpDir, "server.log");
      await mkdir(path.dirname(other), { recursive: true });
      await writeFile(other, "unrelated output");
      const recorder = createDiagnosticsRecorder(logger);
      await recorder.maybeMaintenanceLogs();
      expect((await stat(selected)).size).toBe(0);
      expect((await stat(`${selected}.1`)).size).toBe(LIMIT);
      expect(await readFile(other, "utf8")).toBe("unrelated output");
      await writeFile(selected, Buffer.alloc(LIMIT, "y"));
      await recorder.maybeMaintenanceLogs();
      expect((await stat(selected)).size).toBe(LIMIT); // throttled
      vi.mocked(Date.now).mockReturnValue(5 * 60_000);
      await recorder.maybeMaintenanceLogs();
      expect((await stat(selected)).size).toBe(0);
    }
  );

  it("preserves inode and real open append stdout/stderr writers over repeated rotations", async () => {
    const filePath = path.join(tmpDir, "server.log");
    await writeFile(filePath, Buffer.alloc(LIMIT * 3, "old"));
    const stdout = await open(filePath, "a");
    const stderr = await open(filePath, "a");
    const inode = (await stat(filePath)).ino;
    // A real process keeps stdout/stderr attached throughout all rotations,
    // just as the bundled server inherits the launcher's open descriptors.
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      process.on('message', ({ phase, round }) => {
        fs.writeSync(1, 'stdout-' + phase + '-' + round + '\\n');
        fs.writeSync(2, 'stderr-' + phase + '-' + round + '\\n');
        process.send('written');
      });
    `,
      ],
      { stdio: ["ignore", stdout.fd, stderr.fd, "ipc"] }
    );
    const writeStreams = async (phase: string, round: number) => {
      const written = once(writer, "message");
      writer.send({ phase, round });
      await written;
    };
    try {
      for (let round = 0; round < 5; round++) {
        await writeStreams("before", round);
        await copyTruncateFile(filePath, 3);
        expect((await stat(filePath)).ino).toBe(inode);
        expect((await stat(filePath)).size).toBe(0);
        const backup = await readFile(`${filePath}.1`, "utf8");
        expect(
          backup.endsWith(`stdout-before-${round}\nstderr-before-${round}\n`)
        ).toBe(true);
        expect((await stat(`${filePath}.1`)).size).toBe(LIMIT);
        await writeStreams("after", round);
        expect(await readFile(filePath, "utf8")).toBe(
          `stdout-after-${round}\nstderr-after-${round}\n`
        );
        if (round < 4) await stdout.write(Buffer.alloc(LIMIT, "x"));
      }
      expect((await readdir(tmpDir)).sort()).toEqual([
        "server.log",
        "server.log.1",
        "server.log.2",
        "server.log.3",
      ]);
      for (const suffix of [1, 2, 3])
        expect((await stat(`${filePath}.${suffix}`)).size).toBe(LIMIT);
    } finally {
      const exited = once(writer, "exit");
      writer.disconnect();
      await exited;
      await stdout.close();
      await stderr.close();
    }
  });

  it("bounds oversized historical backups and removes excess backups even with a small active log", async () => {
    const filePath = path.join(tmpDir, "server.log");
    await writeFile(filePath, "live");
    await writeFile(`${filePath}.1`, Buffer.alloc(LIMIT * 2, "a"));
    await writeFile(`${filePath}.2`, Buffer.alloc(LIMIT * 3, "b"));
    await writeFile(`${filePath}.4`, "obsolete");
    await copyTruncateFile(filePath, 3);
    expect((await stat(`${filePath}.1`)).size).toBe(LIMIT);
    expect((await stat(`${filePath}.2`)).size).toBe(LIMIT);
    expect(await readFile(filePath, "utf8")).toBe("live");
    await expect(stat(`${filePath}.4`)).rejects.toThrow();
  });

  it("preserves backup ages when bounding old files and prunes only selected log backups", async () => {
    vi.stubEnv("DISPATCH_STATE_DIR", tmpDir);
    vi.stubEnv("DISPATCH_UPDATE_OWNER", "macos-app");
    const old = new Date(Date.now() - 15 * 24 * 60 * 60_000);
    const filePath = path.join(tmpDir, "server.log");
    await writeFile(filePath, "live");
    await writeFileWithMtime(`${filePath}.1`, "old", old);
    await writeFile(`${filePath}.2`, Buffer.alloc(LIMIT * 2, "x"));
    await utimes(`${filePath}.2`, old, old);
    await writeFileWithMtime(
      path.join(tmpDir, "other-server.log.1"),
      "unrelated",
      old
    );
    await createDiagnosticsRecorder(logger).maybeMaintenanceLogs();
    await expect(stat(`${filePath}.1`)).rejects.toThrow();
    await expect(stat(`${filePath}.2`)).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe("live");
    expect(
      await readFile(path.join(tmpDir, "other-server.log.1"), "utf8")
    ).toBe("unrelated");
  });

  it("documents why non-append manual writers are unsupported: truncation retains their offset", async () => {
    const filePath = path.join(tmpDir, "manual.log");
    const writer = await open(filePath, "w");
    try {
      await writer.write(Buffer.alloc(LIMIT, "x"));
      await copyTruncateFile(filePath, 3);
      await writer.write("after");
      // A regular > redirect creates a sparse hole; use >> for managed paths.
      expect((await stat(filePath)).size).toBe(LIMIT + 5);
      const file = await readFile(filePath);
      expect(file[0]).toBe(0);
      expect(file.subarray(-5).toString()).toBe("after");
    } finally {
      await writer.close();
    }
  });
});
