import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createReleaseRuntime } from "../src/server/release-runtime.js";
import { verifyAndStageRuntime } from "../src/server/release-artifact.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function updateJob(tag = "v9.9.9") {
  return {
    jobType: "update" as const,
    versionType: null,
    phase: "fetching" as const,
    startedAt: new Date().toISOString(),
    log: [],
    runUrl: null,
    tag,
    error: null,
    progress: null,
  };
}

function fixtureArtifact(
  root: string,
  tag: string,
  contents: string,
  checksum?: string
) {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const binaryName = `dispatch-${tag.slice(1)}-bun-${platform}-${arch}`;
  const binaryPath = path.join(root, "dist", "bun", binaryName);
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(binaryPath, contents);
  chmodSync(binaryPath, 0o755);
  const digest = createHash("sha256").update(contents).digest("hex");
  writeFileSync(
    path.join(root, "dist", "bun", "SHA256SUMS.txt"),
    `${checksum ?? digest}  ${binaryName}\n`
  );
  const tarball = path.join(root, "release.tar.gz");
  execFileSync("tar", ["czf", tarball, "dist"], { cwd: root });
  return tarball;
}

function artifactMember(tag: string) {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `dist/bun/dispatch-${tag.slice(1)}-bun-${platform}-${arch}`;
}

function tarRunCommand(command: string, args: string[]) {
  return Promise.resolve({
    stdout: execFileSync(command, args, { encoding: "utf8" }),
    stderr: "",
    exitCode: 0,
  });
}

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

describe("artifact activation", () => {
  it("verifies and atomically activates a release artifact directly", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dispatch-artifact-"));
    tempDirs.push(root);
    const tag = "v9.9.9";
    const tarball = fixtureArtifact(root, tag, "new runtime");
    const livePath = path.join(root, "dispatch");
    writeFileSync(livePath, "old runtime");
    writeFileSync(path.join(root, ".dispatch.next.crashed"), "stale");

    await verifyAndStageRuntime({
      tarballPath: tarball,
      tag,
      livePath,
      runCommand: tarRunCommand,
    });

    expect(readFileSync(livePath, "utf8")).toBe("new runtime");
    expect(readFileSync(`${livePath}.previous`, "utf8")).toBe("old runtime");
    expect(() =>
      readFileSync(path.join(root, ".dispatch.next.crashed"))
    ).toThrow();
  });

  it("atomically promotes a verified runtime and retains one rollback file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dispatch-activate-"));
    tempDirs.push(root);
    const tag = "v9.9.9";
    const tarball = fixtureArtifact(root, tag, "new runtime");
    const livePath = path.join(root, "dispatch");
    writeFileSync(livePath, "old runtime");
    const restartService = vi.fn();
    const writeCandidate = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            tag_name: tag,
            published_at: "2026-01-01T00:00:00Z",
            html_url: "https://example.test/releases/9.9.9",
          }),
          { status: 200 }
        )
      )
    );
    const runtime = createReleaseRuntime({
      pool: { query: vi.fn() } as never,
      config: { tls: false, port: 6767 } as never,
      serverDir: root,
      runCommand: tarRunCommand,
      readReleaseStore: vi
        .fn()
        .mockResolvedValue({ tag: "v9.9.8", deployedAt: "now" }),
      writeReleaseStore: vi.fn(),
      readAssistedUpdateState: vi.fn(),
      isTerminalPhase: vi.fn(),
      ensureCachedTarball: vi.fn().mockResolvedValue({ path: tarball }),
      pruneCacheExcept: vi.fn(),
      unlinkCachedTarball: vi.fn(),
      createReleaseLogStreamProcessor: vi.fn(),
      restartService,
      writeReleaseCandidate: writeCandidate,
    });
    const job = updateJob(tag);
    runtime.setActiveReleaseJob(job);
    await runtime.runUpdateJob(job);

    expect(job.phase).toBe("restarting");
    expect(job.error).toBeNull();
    expect(restartService).toHaveBeenCalledOnce();
    expect(writeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        tag,
        previousTag: "v9.9.8",
      })
    );
    expect(readFileSync(livePath, "utf8")).toBe("new runtime");
    expect(readFileSync(`${livePath}.previous`, "utf8")).toBe("old runtime");
  });

  it("rejects a bad checksum without replacing the live runtime", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dispatch-activate-"));
    tempDirs.push(root);
    const tag = "v9.9.9";
    const tarball = fixtureArtifact(root, tag, "new runtime", "0".repeat(64));
    const livePath = path.join(root, "dispatch");
    writeFileSync(livePath, "old runtime");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            tag_name: tag,
            published_at: "2026-01-01T00:00:00Z",
            html_url: "https://example.test",
          }),
          { status: 200 }
        )
      )
    );
    const unlinkCachedTarball = vi.fn();
    const runtime = createReleaseRuntime({
      pool: { query: vi.fn() } as never,
      config: { tls: false, port: 6767 } as never,
      serverDir: root,
      runCommand: tarRunCommand,
      readReleaseStore: vi.fn(),
      writeReleaseStore: vi.fn(),
      readAssistedUpdateState: vi.fn(),
      isTerminalPhase: vi.fn(),
      ensureCachedTarball: vi.fn().mockResolvedValue({ path: tarball }),
      pruneCacheExcept: vi.fn(),
      unlinkCachedTarball,
      createReleaseLogStreamProcessor: vi.fn(),
      restartService: vi.fn(),
      writeReleaseCandidate: vi.fn(),
    });
    const job = updateJob(tag);
    runtime.setActiveReleaseJob(job);
    await runtime.runUpdateJob(job);

    expect(job.phase).toBe("failed");
    expect(job.error).toContain("Checksum mismatch");
    expect(readFileSync(livePath, "utf8")).toBe("old runtime");
    expect(unlinkCachedTarball).toHaveBeenCalledWith(tag);
  });

  it.each(["duplicate", "symlink"] as const)(
    "rejects a %s runtime member before activation",
    async (kind) => {
      const root = mkdtempSync(path.join(tmpdir(), "dispatch-activate-"));
      tempDirs.push(root);
      const tag = "v9.9.9";
      const tarball = fixtureArtifact(root, tag, "new runtime");
      const member = artifactMember(tag);
      if (kind === "duplicate") {
        execFileSync(
          "tar",
          ["czf", tarball, member, member, "dist/bun/SHA256SUMS.txt"],
          { cwd: root }
        );
      } else {
        const binary = path.join(root, member);
        unlinkSync(binary);
        symlinkSync("elsewhere", binary);
        execFileSync("tar", ["czf", tarball, "dist"], { cwd: root });
      }
      const livePath = path.join(root, "dispatch");
      writeFileSync(livePath, "old runtime");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              tag_name: tag,
              published_at: "2026-01-01T00:00:00Z",
              html_url: "https://example.test",
            }),
            { status: 200 }
          )
        )
      );
      const restartService = vi.fn();
      const runtime = createReleaseRuntime({
        pool: { query: vi.fn() } as never,
        config: { tls: false, port: 6767 } as never,
        serverDir: root,
        runCommand: tarRunCommand,
        readReleaseStore: vi.fn(),
        writeReleaseStore: vi.fn(),
        readAssistedUpdateState: vi.fn(),
        isTerminalPhase: vi.fn(),
        ensureCachedTarball: vi.fn().mockResolvedValue({ path: tarball }),
        pruneCacheExcept: vi.fn(),
        unlinkCachedTarball: vi.fn(),
        createReleaseLogStreamProcessor: vi.fn(),
        restartService,
        writeReleaseCandidate: vi.fn(),
      });
      const job = updateJob(tag);
      runtime.setActiveReleaseJob(job);
      await runtime.runUpdateJob(job);

      expect(job.phase).toBe("failed");
      expect(readFileSync(livePath, "utf8")).toBe("old runtime");
      expect(restartService).not.toHaveBeenCalled();
    }
  );
});
