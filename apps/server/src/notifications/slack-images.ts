import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import {
  IMAGE_SCOPES,
  SlackApiError,
  SlackAuthError,
  SlackDeliveryUnknownError,
  SlackRetryError,
  type SlackApp,
} from "./slack-app.js";
import { clip, type SlackBlock } from "./slack-blocks.js";

/** Slack shows png/jpeg/gif from `slack_file`; keep messages light. */
export const IMAGE_LIMITS = { count: 4, bytes: 5 * 1024 * 1024 } as const;
const TYPES = new Set([".png", ".jpg", ".jpeg", ".gif"]);

export type LoadedImage = { name: string; bytes: Uint8Array; digest: string };

/** PNG, JPEG or GIF by content, not by name. */
function isImage(bytes: Uint8Array) {
  const at = (i: number) => bytes[i];
  return (
    (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) ||
    (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) ||
    (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
  );
}

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
    let bytes: Uint8Array;
    try {
      // Checks apply to the file actually read, not a name or a symlink.
      const real = await realpath(path);
      if (!TYPES.has(extname(real).toLowerCase()))
        return { error: `Slack shows png, jpg or gif images only: ${name}.` };
      const info = await stat(real);
      if (!info.isFile()) return { error: `Not a file: ${name}.` };
      if (info.size > IMAGE_LIMITS.bytes)
        return { error: `Image over 5 MB: ${name}.` };
      bytes = new Uint8Array(await readFile(real));
    } catch {
      return { error: `Can't read image: ${name}.` };
    }
    if (!isImage(bytes))
      return { error: `Not a png, jpg or gif image: ${name}.` };
    images.push({
      name,
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
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

/**
 * Waits before re-posting a message whose image Slack hadn't finished
 * processing. Slack processes an upload after files.completeUploadExternal
 * returns; until then chat.postMessage refuses its `slack_file` with
 * `invalid_blocks` and posts nothing. About 7s in all.
 */
export const IMAGE_READY_RETRY_MS = [1000, 2000, 4000] as const;

/**
 * Post a message with its uploaded images. If Slack refuses an image it is
 * still processing (definitely not posted), wait and post the same message
 * again, a bounded number of times. If Slack still won't show the images,
 * or rejects the message for another definite reason, the words go out once
 * without them and `note` says why (Slack's error code only). Outcomes that
 * may have posted, rate limits and auth failures are never retried.
 */
export async function postWithImages<T>(
  app: Pick<SlackApp, "waitForSendSlot">,
  pictures: { blocks: SlackBlock[]; skipped?: string },
  post: (images: SlackBlock[]) => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<{ sent: T; note?: string; rejectedCode?: string }> {
  if (!pictures.blocks.length)
    return { sent: await post([]), note: pictures.skipped };
  let rejection: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return { sent: await post(pictures.blocks) };
    } catch (error) {
      if (
        error instanceof SlackRetryError ||
        error instanceof SlackDeliveryUnknownError ||
        error instanceof SlackAuthError
      )
        throw error;
      rejection = error;
      const processing =
        error instanceof SlackApiError && error.slackFileRejected;
      if (!processing || attempt >= IMAGE_READY_RETRY_MS.length) break;
      await sleep(IMAGE_READY_RETRY_MS[attempt]!);
      // Each try counts against the local 1 msg/s guard.
      await app.waitForSendSlot();
    }
  }
  const code =
    rejection instanceof SlackApiError ? rejection.code : "request_failed";
  await app.waitForSendSlot();
  const sent = await post([]);
  const note =
    rejection instanceof SlackApiError && rejection.slackFileRejected
      ? `Images weren't attached: Slack still hadn't finished processing them after several tries (${code}).`
      : `Images weren't attached: Slack rejected the message with them (${code}).`;
  return { sent, note, rejectedCode: code };
}
