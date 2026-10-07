import type { Pool } from "pg";
import {
  DEFAULT_USER_AVATAR,
  USER_AVATAR_MAX_BYTES,
  USER_AVATAR_PRESETS,
  USER_AVATAR_SIZE,
  type UserAvatar,
  type UserAvatarPreset,
} from "@dispatch/shared";
import { getSetting, setSetting } from "./db/settings.js";
import { imageDimensionsFromBuffer } from "./files/image-dimensions.js";

const KEY = "user_avatar";

/** Restrict stored images to small raster data URLs, never SVG or remote URLs. */
export function parseUserAvatar(value: unknown): UserAvatar | null {
  if (!value || typeof value !== "object") return null;
  const avatar = value as Record<string, unknown>;
  if (
    avatar.kind === "builtin" &&
    typeof avatar.id === "string" &&
    USER_AVATAR_PRESETS.includes(avatar.id as UserAvatarPreset)
  ) {
    return { kind: "builtin", id: avatar.id as UserAvatarPreset };
  }
  if (avatar.kind !== "image" || typeof avatar.dataUrl !== "string")
    return null;
  if (avatar.dataUrl.length > Math.ceil(USER_AVATAR_MAX_BYTES / 3) * 4 + 32)
    return null;
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      avatar.dataUrl
    );
  if (!match) return null;
  const bytes = Buffer.from(match[2]!, "base64");
  if (
    bytes.length > USER_AVATAR_MAX_BYTES ||
    bytes.toString("base64") !== match[2]
  )
    return null;
  const format = match[1];
  const validMagic =
    format === "png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : format === "jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validMagic) return null;
  const dimensions = imageDimensionsFromBuffer(bytes, {
    ignoreExifOrientation: true,
  });
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.width > USER_AVATAR_SIZE ||
    dimensions.width !== dimensions.height
  )
    return null;
  return { kind: "image", dataUrl: avatar.dataUrl };
}

export async function getUserAvatar(pool: Pool): Promise<UserAvatar> {
  const stored = await getSetting(pool, KEY);
  if (!stored) return DEFAULT_USER_AVATAR;
  try {
    return parseUserAvatar(JSON.parse(stored)) ?? DEFAULT_USER_AVATAR;
  } catch {
    return DEFAULT_USER_AVATAR;
  }
}

export async function setUserAvatar(
  pool: Pool,
  avatar: UserAvatar
): Promise<void> {
  await setSetting(pool, KEY, JSON.stringify(avatar));
}
