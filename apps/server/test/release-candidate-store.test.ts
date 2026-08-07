import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  promoteHealthyReleaseCandidate,
  readReleaseCandidate,
  writeReleaseCandidate,
} from "../src/release-candidate-store.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.DISPATCH_RELEASE_CANDIDATE_STORE_PATH;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("release candidate promotion", () => {
  it("only promotes the newly healthy binary's candidate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-candidate-"));
    roots.push(root);
    process.env.DISPATCH_RELEASE_CANDIDATE_STORE_PATH = path.join(
      root,
      "candidate.json"
    );
    await writeReleaseCandidate({
      tag: "v9.9.9",
      previousTag: "v9.9.8",
      activatedAt: "2026-01-01T00:00:00.000Z",
    });
    const writeReleaseStore = vi.fn().mockResolvedValue(undefined);

    await expect(
      promoteHealthyReleaseCandidate({
        expectedTag: "v9.9.8",
        writeReleaseStore,
      })
    ).resolves.toBe(false);
    expect(writeReleaseStore).not.toHaveBeenCalled();
    expect(await readReleaseCandidate()).toMatchObject({ tag: "v9.9.9" });

    await expect(
      promoteHealthyReleaseCandidate({
        expectedTag: "v9.9.9",
        writeReleaseStore,
      })
    ).resolves.toBe(true);
    expect(writeReleaseStore).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "v9.9.9" })
    );
    expect(await readReleaseCandidate()).toBeNull();
  });
});
