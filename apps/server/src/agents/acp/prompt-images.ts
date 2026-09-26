import { open } from "node:fs/promises";
import type { ImageContent } from "@agentclientprotocol/sdk";
import type { PromptImage } from "./prompt-source.js";

// Bound both memory and the ACP request. File references remain in the envelope
// when an image is too large or unavailable, so the agent can use its file tools.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export async function readPromptImages(
  images: PromptImage[],
  logger: { warn: (obj: Record<string, unknown>, message: string) => void }
): Promise<(ImageContent & { type: "image" })[]> {
  const blocks: (ImageContent & { type: "image" })[] = [];
  let remaining = MAX_PROMPT_IMAGE_BYTES;
  const seen = new Set<string>();
  for (const image of images) {
    if (!MIME_TYPES.has(image.mimeType) || seen.has(image.path)) continue;
    seen.add(image.path);
    try {
      const file = await open(image.path, "r");
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > Math.min(MAX_IMAGE_BYTES, remaining)
        ) {
          logger.warn(
            { path: image.path },
            "Image prompt limit exceeded; retaining file reference"
          );
          continue;
        }
        // A bounded read also handles a file that grows after stat.
        const bytes = Buffer.alloc(Math.min(MAX_IMAGE_BYTES, remaining) + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            size,
            bytes.length - size,
            null
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size === 0 || size === bytes.length) continue;
        remaining -= size;
        blocks.push({
          type: "image",
          mimeType: image.mimeType,
          data: bytes.subarray(0, size).toString("base64"),
        });
      } finally {
        await file.close();
      }
    } catch (err) {
      logger.warn(
        { err, path: image.path },
        "Could not attach native image; retaining file reference"
      );
    }
  }
  return blocks;
}
