import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { IMAGE_SCOPES, type SlackApp } from "./slack-app.js";
import { clip, type SlackBlock } from "./slack-blocks.js";

/** Slack shows png/jpeg/gif from `slack_file`; keep messages light. */
export const IMAGE_LIMITS = { count: 4, bytes: 5 * 1024 * 1024 } as const;
const TYPES = new Set([".png", ".jpg", ".jpeg", ".gif"]);

export type LoadedImage = { name: string; bytes: Uint8Array };

/**
 * Agent-named image files (absolute paths on this machine, as `post`
 * attachments take them). Returns the images to send, or the reason none
 * can be; nothing partial: a bad path refuses the whole set so the agent
 * can fix it rather than silently losing one.
 */
export async function loadImages(
  paths: string[] | undefined
): Promise<{ images: LoadedImage[] } | { error: string }> {
  if (!paths?.length) return { images: [] };
  if (paths.length > IMAGE_LIMITS.count)
    return { error: `At most ${IMAGE_LIMITS.count} images per message.` };
  const images: LoadedImage[] = [];
  for (const path of paths) {
    const name = basename(path);
    if (!isAbsolute(path))
      return { error: `Image path must be absolute: ${name}.` };
    if (!TYPES.has(extname(path).toLowerCase()))
      return { error: `Slack shows png, jpg or gif images only: ${name}.` };
    try {
      const info = await stat(path);
      if (!info.isFile()) return { error: `Not a file: ${name}.` };
      if (info.size > IMAGE_LIMITS.bytes)
        return { error: `Image over 5 MB: ${name}.` };
      images.push({ name, bytes: new Uint8Array(await readFile(path)) });
    } catch {
      return { error: `Can't read image: ${name}.` };
    }
  }
  return { images };
}

/**
 * Upload images privately and return image blocks, or why they can't be
 * shown (missing `files:write`, upload failure). The message itself still
 * goes out; the caller reports what happened to the images.
 */
export async function imageBlocks(
  app: Pick<SlackApp, "uploadImage" | "hasScope">,
  images: LoadedImage[]
): Promise<{ blocks: SlackBlock[]; skipped?: string }> {
  if (!images.length) return { blocks: [] };
  if (app.hasScope(IMAGE_SCOPES[0]!) === false)
    return {
      blocks: [],
      skipped:
        "Images weren't attached: the Slack app needs the files:write permission (Settings → Slack: update the app manifest and reinstall).",
    };
  const blocks: SlackBlock[] = [];
  try {
    for (const image of images) {
      const id = await app.uploadImage(image.bytes, image.name);
      blocks.push({
        type: "image",
        slack_file: { id },
        alt_text: clip(image.name, 2000),
      });
    }
  } catch {
    return {
      blocks: [],
      skipped: "Images weren't attached: Slack didn't accept the upload.",
    };
  }
  return { blocks };
}
