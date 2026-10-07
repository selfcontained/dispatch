import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, describe, beforeEach, afterEach, vi } from "vitest";
import type { Pool } from "pg";
import {
  sampleArtifactStorage,
  sampleRetainedArtifactStorage,
  discoverArtifactRoots,
} from "../src/observability/artifact-storage.js";

it("counts historical files while deduplicating roots and ignoring nested symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-storage-"));
  try {
    const files = path.join(root, "files");
    const archived = path.join(files, "archived-agent");
    const outside = path.join(root, "outside");
    await mkdir(archived, { recursive: true });
    await mkdir(outside);
    await writeFile(
      path.join(archived, "unregistered.bin"),
      Buffer.alloc(8192)
    );
    await writeFile(path.join(outside, "large.bin"), Buffer.alloc(1024 * 1024));
    await symlink(outside, path.join(archived, "external"));
    const size = await sampleArtifactStorage([files]);
    expect(size).toBeGreaterThanOrEqual(8192);
    expect(size).toBeLessThan(1024 * 1024);
    expect(
      await sampleArtifactStorage([
        files,
        archived,
        files,
        path.join(root, "missing"),
      ])
    ).toBe(size);
    expect(await sampleArtifactStorage([path.join(root, "missing")])).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The database watchdog must retire clients, not just abandon their promises.
describe("artifact root discovery lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retires a stalled query and allows the next discovery to succeed", async () => {
    const release = vi.fn();
    const query = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ rows: [{ files_dir: "/tmp/retained" }] });
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const first = discoverArtifactRoots(pool, new AbortController().signal);
    const rejected = expect(first).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(
      await discoverArtifactRoots(pool, new AbortController().signal)
    ).toEqual(["/tmp/retained"]);
    expect(release).toHaveBeenLastCalledWith(undefined);
  });

  it("retires a connection acquired after cancellation without querying it", async () => {
    let connect!: (client: unknown) => void;
    const pool = {
      connect: () =>
        new Promise((resolve) => {
          connect = resolve;
        }),
    } as unknown as Pool;
    const controller = new AbortController();
    const probe = discoverArtifactRoots(pool, controller.signal);
    const rejected = expect(probe).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
    const client = { query: vi.fn(), release: vi.fn() };
    connect(client);
    await Promise.resolve();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });

  it("does not start disk measurement when a cancelled root query completes late", async () => {
    let resolveQuery!: (value: unknown) => void;
    const release = vi.fn();
    const query = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        })
    );
    const pool = {
      connect: async () => ({ query, release }),
    } as unknown as Pool;
    const controller = new AbortController();
    const measure = vi.fn(async () => 10);
    const scan = sampleRetainedArtifactStorage(
      pool,
      ["/tmp/files"],
      controller.signal,
      measure
    );
    const rejected = expect(scan).rejects.toThrow("cancelled");
    await Promise.resolve();
    controller.abort();
    await rejected;
    resolveQuery({ rows: [{ files_dir: "/tmp/other" }] });
    await Promise.resolve();
    expect(measure).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });
});
