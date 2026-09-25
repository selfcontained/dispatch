import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sampleArtifactStorage } from "../src/observability/artifact-storage.js";

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
