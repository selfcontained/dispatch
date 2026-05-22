import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReleaseRuntime,
  pruneReleaseBinaries,
} from "../src/server/release-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("release runtime stream targeting", () => {
  it("sends targeted release events only to the matching stream client", () => {
    const runtime = createReleaseRuntime({
      pool: { query: vi.fn() } as never,
      config: { tls: false, port: 6767 } as never,
      serverDir: "/tmp/dispatch",
      runCommand: vi.fn(),
      readReleaseStore: vi.fn(),
      writeReleaseStore: vi.fn(),
      readAssistedUpdateState: vi.fn(),
      isTerminalPhase: vi.fn(),
      ensureCachedTarball: vi.fn(),
      pruneCacheExcept: vi.fn(),
      unlinkCachedTarball: vi.fn(),
      createReleaseLogStreamProcessor: vi.fn(),
    });

    const writeA = vi.fn();
    const writeB = vi.fn();
    runtime.releaseStreamClients.add({
      clientId: "client-a",
      stream: { write: writeA } as never,
    });
    runtime.releaseStreamClients.add({
      clientId: "client-b",
      stream: { write: writeB } as never,
    });

    runtime.sendReleaseEventToClient("client-b", {
      type: "info-progress",
      progress: {
        step: "downloading-release-package",
        label: "Downloading release package",
        bytesReceived: 32,
        totalBytes: 64,
      },
    });

    expect(writeA).not.toHaveBeenCalled();
    expect(writeB).toHaveBeenCalledTimes(1);
    expect(writeB.mock.calls[0]?.[0]).toContain('"type":"info-progress"');
  });
});

describe("pruneReleaseBinaries", () => {
  it("removes stale release binaries while keeping the deployed version", () => {
    const serverDir = mkdtempSync(path.join(tmpdir(), "dispatch-release-"));
    tempDirs.push(serverDir);
    const bunDir = path.join(serverDir, "dist/bun");
    mkdirSync(bunDir, { recursive: true });

    writeFileSync(
      path.join(bunDir, "dispatch-0.21.1-bun-darwin-arm64"),
      "current"
    );
    writeFileSync(
      path.join(bunDir, "dispatch-0.21.0-bun-darwin-arm64"),
      "old-a"
    );
    writeFileSync(path.join(bunDir, "dispatch-0.20.9-bun-linux-x64"), "old-b");
    writeFileSync(
      path.join(bunDir, "dispatch-0.21.10-bun-darwin-arm64"),
      "old-c"
    );
    writeFileSync(path.join(bunDir, "README.txt"), "keep");

    const removed = pruneReleaseBinaries(serverDir, "v0.21.1");

    expect(removed).toBe(3);
    expect(readdirSync(bunDir).sort()).toEqual([
      "README.txt",
      "dispatch-0.21.1-bun-darwin-arm64",
    ]);
  });
});
