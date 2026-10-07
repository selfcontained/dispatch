import { USER_AVATAR_MAX_BYTES, USER_AVATAR_SIZE } from "@dispatch/shared";

export const AVATAR_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 64_000_000;
const FORMATS = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
];
const EXTENSION = /\.(png|jpe?g|webp|heic|heif)$/i;

async function decode(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = "";
        URL.revokeObjectURL(url);
      },
    };
  } catch {
    image.src = "";
    URL.revokeObjectURL(url);
  }
  // Native decoding handles orientation and avoids loading a converter on browsers
  // that already support HEIC. Only load the fallback after native decoding fails.
  if (/heic|heif/.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    try {
      const { heicTo } = await import("heic-to/csp");
      const bitmap = await heicTo({ blob: file, type: "bitmap" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      throw new Error(
        "This HEIC photo could not be opened. Try another photo or export it as JPEG."
      );
    }
  }
  throw new Error("This image could not be opened. Try another photo.");
}

/** Center-crop and downsize locally; only the small avatar leaves the browser. */
export async function prepareAvatarPhoto(
  file: File
): Promise<HTMLCanvasElement> {
  // Mobile file providers sometimes omit the MIME type or use octet-stream.
  if (
    !FORMATS.includes(file.type) &&
    !(
      (!file.type || file.type === "application/octet-stream") &&
      EXTENSION.test(file.name)
    )
  ) {
    throw new Error("Choose a PNG, JPEG, WebP, HEIC or HEIF image.");
  }
  if (file.size > AVATAR_SOURCE_MAX_BYTES)
    throw new Error("Choose an image up to 50 MB.");
  const decoded = await decode(file);
  try {
    const { width, height, source } = decoded;
    if (!width || !height || width * height > MAX_PIXELS)
      throw new Error("Choose an image up to 64 megapixels.");
    // Keep a modest working image for interactive cropping and release the original.
    const scale = Math.min(1, 2048 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Your browser could not prepare this image.");
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    decoded.release();
  }
}

export type AvatarCrop = { x: number; y: number; zoom: number };
export const DEFAULT_CROP: AvatarCrop = { x: 0.5, y: 0.5, zoom: 1 };

export function drawAvatarCrop(
  photo: HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  crop: AvatarCrop
) {
  const side = Math.min(photo.width, photo.height) / crop.zoom;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not prepare this image.");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    photo,
    crop.x * (photo.width - side),
    crop.y * (photo.height - side),
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height
  );
}

export function encodeAvatar(
  photo: HTMLCanvasElement,
  crop: AvatarCrop
): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = USER_AVATAR_SIZE;
  drawAvatarCrop(photo, canvas, crop);
  for (const type of ["image/webp", "image/jpeg"]) {
    for (const quality of [0.85, 0.7, 0.5]) {
      const dataUrl = canvas.toDataURL(type, quality);
      if (
        dataUrl.startsWith(`data:${type};base64,`) &&
        ((dataUrl.split(",")[1]?.length ?? 0) * 3) / 4 <= USER_AVATAR_MAX_BYTES
      )
        return dataUrl;
    }
  }
  throw new Error("This image could not be resized. Try another photo.");
}
