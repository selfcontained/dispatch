import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn() };
});

import { readdir } from "node:fs/promises";

import { discoverSessionFiles } from "../src/agents/token-harvester.js";
import { mountIO } from "../src/shared/mount-io/index.js";

describe("discoverSessionFiles under a stalled mount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mountIO.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(readdir).mockReset();
    mountIO.reset();
  });

  it("returns [] instead of hanging when readdir never resolves", async () => {
    vi.mocked(readdir).mockReturnValue(
      new Promise(() => {}) as unknown as ReturnType<typeof readdir>,
    );

    const p = discoverSessionFiles("/mnt/claude/projects/whatever");
    const assertion = expect(p).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it("returns parsed file list when readdir resolves normally", async () => {
    vi.mocked(readdir).mockResolvedValue([
      "a.jsonl",
      "b.txt",
      "c.jsonl",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await expect(discoverSessionFiles("/p")).resolves.toEqual([
      "/p/a.jsonl",
      "/p/c.jsonl",
    ]);
  });
});
