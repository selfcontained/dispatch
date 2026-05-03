import { describe, expect, it, vi } from "vitest";

import { createReleaseRuntime } from "../src/server/release-runtime.js";

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
