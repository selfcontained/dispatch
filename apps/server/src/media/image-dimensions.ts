/**
 * Natural pixel dimensions read straight out of an image file's header.
 *
 * The chat feed reserves space for an image before it loads, so it needs the
 * aspect ratio at render time — which means the ratio has to be on the media
 * row, which means something has to read it at upload time. That is all this
 * module does: parse the handful of bytes that carry width and height for the
 * formats `isImageFile` accepts (PNG, JPEG, GIF, WebP).
 *
 * Deliberately dependency-free. The alternative was `sharp`, which is a
 * native binary an order of magnitude larger than the code below and would
 * become the server's first compiled dependency, all to read numbers that sit
 * in the first few dozen bytes of the file.
 *
 * Every entry point is total: anything unrecognised, truncated, or malformed
 * returns `null` rather than throwing. An upload must never fail because its
 * dimensions could not be read — such a row stores nulls and renders in the
 * fixed-height fallback box.
 */

import { open } from "node:fs/promises";

import { isImageFile } from "../shared/media-file-types.js";

export type ImageDimensions = { width: number; height: number };

/**
 * How much of a file to read when probing from disk. PNG, GIF and WebP put
 * their dimensions in the first 32 bytes; only JPEG can push its SOF frame
 * deep, behind EXIF metadata and an embedded thumbnail. 1 MiB clears that for
 * anything a camera or screenshot tool produces without slurping a whole
 * multi-megabyte image into memory.
 */
const PROBE_HEAD_BYTES = 1024 * 1024;

/** Largest value we will believe. Guards against a corrupt header. */
const MAX_DIMENSION = 100_000;

function valid(width: number, height: number): ImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

/**
 * PNG: the IHDR chunk is required to come first, so width and height are at
 * fixed offsets 16 and 20 as big-endian uint32s.
 */
function pngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24) return null;
  // A missing IHDR means this is not a PNG we can trust the offsets for.
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return valid(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

/** GIF: fixed-position little-endian uint16s in the logical screen descriptor. */
function gifDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return valid(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

/**
 * JPEG markers that introduce a Start Of Frame — the only segment carrying the
 * image's size. 0xC0–0xCF is the SOF range with three exceptions that reuse
 * the space for other tables (DHT, JPG, DAC).
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG: walk the segment chain from SOI until a SOF frame turns up. Segments
 * are `FF <marker> <uint16 length>`, length inclusive of itself, so each hop
 * is a read of two numbers — no need to understand any segment's contents.
 */
function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // Fill bytes are legal between segments; anything else means the chain
      // is broken and further hops would be reading noise.
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    // Padding (0xFF) and standalone markers carry no length word.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    // Start of scan: entropy-coded data follows, and any SOF is behind us.
    if (marker === 0xda) return null;

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;

    if (isStartOfFrame(marker)) {
      // SOF payload: precision byte, then height and width as uint16s.
      if (offset + 9 > buffer.length) return null;
      return valid(
        buffer.readUInt16BE(offset + 7),
        buffer.readUInt16BE(offset + 5)
      );
    }

    offset += 2 + length;
  }
  return null;
}

/**
 * WebP: a RIFF container whose first chunk says which of three encodings the
 * file uses, each storing its size differently.
 */
function webpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 16) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;

  const chunk = buffer.toString("ascii", 12, 16);

  if (chunk === "VP8X") {
    // Extended format: canvas size as two 24-bit little-endian (value - 1).
    if (buffer.length < 30) return null;
    return valid(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
  }

  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, a start code, then 14-bit dimensions each
    // sharing its uint16 with two scale bits.
    if (buffer.length < 30) return null;
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null;
    }
    return valid(
      buffer.readUInt16LE(26) & 0x3fff,
      buffer.readUInt16LE(28) & 0x3fff
    );
  }

  if (chunk === "VP8L") {
    // Lossless: signature byte, then 14 bits of (width - 1) and 14 of
    // (height - 1) packed little-endian across the next four bytes.
    if (buffer.length < 25) return null;
    if (buffer[20] !== 0x2f) return null;
    const bits =
      buffer[21]! |
      (buffer[22]! << 8) |
      (buffer[23]! << 16) |
      (buffer[24]! << 24);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  return null;
}

/**
 * Natural dimensions of an image already in memory, or `null` when the bytes
 * are not a format we parse or the header does not hold up.
 *
 * Format is decided by the file's own magic bytes, not by its name — a
 * screenshot saved as `.png` that is really a JPEG still measures correctly.
 */
export function imageDimensionsFromBuffer(
  buffer: Buffer
): ImageDimensions | null {
  try {
    if (isPng(buffer)) return pngDimensions(buffer);
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      return jpegDimensions(buffer);
    }
    if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") {
      return gifDimensions(buffer);
    }
    if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "RIFF") {
      return webpDimensions(buffer);
    }
    return null;
  } catch {
    // A truncated buffer can make a bounds-checked read throw anyway; treat it
    // the same as an unreadable header.
    return null;
  }
}

/**
 * Same, for a file on disk. Reads only the head of the file, so probing a
 * large image costs one bounded read rather than loading it whole.
 *
 * Non-image extensions short-circuit without touching the filesystem: the
 * media table holds video, PDFs and text too, and none of those have
 * dimensions worth reserving space for.
 */
export async function probeImageFile(
  filePath: string
): Promise<ImageDimensions | null> {
  if (!isImageFile(filePath)) return null;

  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(PROBE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PROBE_HEAD_BYTES, 0);
    return imageDimensionsFromBuffer(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
