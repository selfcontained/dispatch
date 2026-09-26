import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readPromptImages } from "../src/agents/acp/prompt-images.js";

it("bounds native images and retains readable files after missing, oversized, or unsupported attachments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-images-"));
  try {
    const large = path.join(dir, "large.png");
    const file = await open(large, "w");
    await file.truncate(10 * 1024 * 1024 + 1);
    await file.close();
    const good = path.join(dir, "small.png");
    await writeFile(good, "image bytes");
    const logger = { warn: vi.fn() };
    const blocks = await readPromptImages(
      [
        { path: path.join(dir, "missing.png"), mimeType: "image/png" },
        { path: large, mimeType: "image/png" },
        { path: good, mimeType: "application/pdf" },
        { path: good, mimeType: "image/png" },
        { path: good, mimeType: "image/png" },
      ],
      logger
    );
    expect(blocks).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("image bytes").toString("base64"),
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
