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
 * fixed offsets 16 and 20 as big-endian uint32s. An `eXIf` chunk may follow
 * with an orientation that turns them.
 */
function pngDimensions(buffer: Buffer): ImageDimensions | null {
  // The whole IHDR chunk: 8 signature, 4 length, 4 type, 13 data, 4 CRC.
  if (buffer.length < 33) return null;
  // A missing IHDR means this is not a PNG we can trust the offsets for, and
  // a length other than 13 means the chunk claiming to own those bytes is not
  // the chunk we are about to read.
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  if (buffer.readUInt32BE(8) !== 13) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const orientation = pngOrientation(buffer);
  // Null means the chunk walk ran off the end of what we hold, so an
  // orientation could still be ahead of us. Answering from the IHDR alone
  // would be a coin flip on whether the image is rotated.
  if (orientation === null) return null;
  return swapsAxes(orientation) ? valid(height, width) : valid(width, height);
}

/**
 * The orientation in a PNG's `eXIf` chunk: 1 once the walk has proved there is
 * none, or `null` when it could not get far enough to know.
 *
 * Chunks are `length | type | data | crc`, walked from the end of the
 * signature. Reaching `IDAT` settles the question — metadata that a renderer
 * honours is required to precede the pixel data — and reaching it is enough,
 * so a large image is never paged through to answer.
 *
 * Running out of buffer first is the case that must not be mistaken for "no
 * orientation": `probeImageFile` reads a bounded head, and a big enough
 * metadata chunk ahead of `eXIf` pushes it past the end of that read.
 */
function pngOrientation(buffer: Buffer): number | null {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    // Pixel data has started: anything after it cannot change the layout.
    if (type === "IDAT" || type === "IEND") return 1;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === "eXIf") {
      if (dataEnd > buffer.length) return null;
      // The chunk holds a bare TIFF block — no "Exif\0\0" lead-in.
      return tiffOrientation(buffer, dataStart, dataEnd) ?? 1;
    }
    // Skipping a chunk needs only its declared length, not its bytes, but the
    // next header has to be inside the buffer for the walk to continue.
    offset = dataEnd + 4;
    if (offset > buffer.length) return null;
  }
  return null;
}

/** GIF: fixed-position little-endian uint16s in the logical screen descriptor. */
function gifDimensions(buffer: Buffer): ImageDimensions | null {
  // The full logical screen descriptor, not just the two size fields at its
  // front — a file cut short of it is one no browser will render either.
  if (buffer.length < 13) return null;
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
 * EXIF orientations 5 through 8 include a quarter turn, which swaps the
 * image's rendered width and height.
 *
 * This matters because a browser applies the tag when it decodes: the default
 * `image-orientation: from-image` means a 120x90 file tagged "rotate 90" has
 * `naturalWidth` 90 and `naturalHeight` 120. Reserving space from the raw SOF
 * numbers would give every rotated phone photo a box at the wrong ratio — the
 * exact dead space this module exists to remove, only sideways.
 */
function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * The orientation tag in a TIFF block, or `null` when the block does not carry
 * one.
 *
 * Null and 1 are different answers on purpose: a file can hold several
 * metadata blocks, and one without an orientation must not be allowed to
 * reset an orientation an earlier block did declare.
 *
 * Only IFD0 is walked, and only for tag 0x0112 — this is not a general EXIF
 * reader, it answers one question. Every read is bounds-checked, so a
 * malformed block costs nothing.
 */
function tiffOrientation(
  buffer: Buffer,
  tiff: number,
  end: number
): number | null {
  if (end - tiff < 8) return null;

  const byteOrder = buffer.toString("ascii", tiff, tiff + 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return null;
  const u16 = (at: number) =>
    littleEndian ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (at: number) =>
    littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);

  if (u16(tiff + 2) !== 42) return null;
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 < tiff || ifd0 + 2 > end) return null;

  const entries = u16(ifd0);
  for (let i = 0; i < entries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) !== 0x0112) continue;
    // SHORT, exactly one of them, stored inline because it fits the field.
    if (u16(entry + 2) !== 3) return null;
    if (u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/**
 * The orientation in one APP1 segment, or `null` when that segment is not an
 * EXIF block or carries no orientation.
 *
 * A JPEG may hold several APP1 segments — an EXIF block and an XMP block, say
 * — so returning 1 for the ones without an orientation would let a later
 * segment quietly cancel an earlier segment's rotation.
 */
function app1Orientation(
  buffer: Buffer,
  start: number,
  end: number
): number | null {
  // The full "Exif\0\0" signature, not just the four letters: XMP's APP1
  // opens with a URI, and other vendors put their own tags here.
  if (end - start < 8) return null;
  if (buffer.toString("ascii", start, start + 4) !== "Exif") return null;
  if (buffer[start + 4] !== 0x00 || buffer[start + 5] !== 0x00) return null;
  return tiffOrientation(buffer, start + 6, end);
}

/**
 * JPEG: walk the segment chain from SOI, collecting the frame size and the
 * EXIF orientation, and stop at the start of the scan.
 *
 * The walk does not stop at the frame header even though that is where the
 * numbers are. Encoders are free to put an APP1 after the SOF, and a browser
 * honours it — so returning early there would read the size correctly and the
 * rotation not at all. Metadata is only fully known once the scan begins.
 *
 * The walk is otherwise strict about structure. A byte that is not 0xFF where
 * a marker belongs means the chain is broken, and every byte after it is noise
 * that can still happen to look like a SOF — scanning ahead for one is how a
 * parser reports confident dimensions for a file that is not a JPEG at all. A
 * wrong answer is worse here than no answer: it reserves a box the image
 * cannot fit, where `null` would have fallen back to a box that at least holds
 * still.
 */
function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  let orientation = 1;
  let frame: { width: number; height: number } | null = null;

  const settle = (): ImageDimensions | null => {
    if (!frame) return null;
    return swapsAxes(orientation)
      ? valid(frame.height, frame.width)
      : valid(frame.width, frame.height);
  };

  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    // Any number of 0xFF fill bytes may pad the gap before the marker itself.
    let markerAt = offset + 1;
    while (markerAt < buffer.length && buffer[markerAt] === 0xff) markerAt += 1;
    if (markerAt >= buffer.length) return null;
    const marker = buffer[markerAt]!;

    // TEM is the only standalone marker legal out here. Restart markers
    // (0xD0-0xD7) belong inside entropy-coded scan data, which this walk never
    // enters, so accepting them would wave through a broken chain.
    if (marker === 0x01) {
      offset = markerAt + 1;
      continue;
    }
    // A padding byte or a second SOI at a segment boundary means the chain is
    // not what it claims to be.
    if (marker === 0x00 || marker === 0xd8) return null;
    // End of image before any scan: there is no image here to size.
    if (marker === 0xd9) return null;
    if (marker >= 0xd0 && marker <= 0xd7) return null;

    if (markerAt + 3 > buffer.length) return null;
    const lengthAt = markerAt + 1;
    const length = buffer.readUInt16BE(lengthAt);
    if (length < 2) return null;
    const segmentEnd = lengthAt + length;
    // A segment running past what we hold means the head read stopped short;
    // there is nothing trustworthy left to walk.
    if (segmentEnd > buffer.length) return null;

    // Start of scan: metadata is complete, and the frame we collected is the
    // one the scan is about to encode. Its header is `Ns` components of two
    // bytes each, wrapped in six bytes of its own.
    if (marker === 0xda) {
      const components = buffer[lengthAt + 2]!;
      if (components < 1 || components > 4) return null;
      if (length !== 6 + components * 2) return null;
      return settle();
    }

    if (marker === 0xe1) {
      const found = app1Orientation(buffer, lengthAt + 2, segmentEnd);
      if (found !== null) orientation = found;
    }

    if (isStartOfFrame(marker) && !frame) {
      // Payload: precision, height, width, component count, then three bytes
      // per component. Checking the length against that shape is what stops a
      // stray 0xFFC0 in unrelated bytes from passing as a frame header.
      if (length < 8) return null;
      const precision = buffer[lengthAt + 2]!;
      const components = buffer[lengthAt + 7]!;
      if (precision !== 8 && precision !== 12 && precision !== 16) return null;
      if (components < 1 || components > 4) return null;
      if (length !== 8 + components * 3) return null;

      frame = {
        height: buffer.readUInt16BE(lengthAt + 3),
        width: buffer.readUInt16BE(lengthAt + 5),
      };
    }

    offset = segmentEnd;
  }
  // Ran out of bytes before the scan started: the metadata was not all there,
  // so any orientation still ahead of us would be missed.
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
  const chunkSize = buffer.readUInt32LE(16);
  // The RIFF payload has to have room for "WEBP" plus this chunk's header and
  // body, or the container is lying about what it holds. Checked against the
  // declared sizes rather than the buffer: a large WebP is probed from a head
  // read that legitimately stops short of the file's end.
  if (buffer.readUInt32LE(4) < 12 + chunkSize) return null;
  const fits = (bytes: number) => chunkSize >= bytes;

  if (chunk === "VP8X") {
    // Extended format: canvas size as two 24-bit little-endian (value - 1),
    // behind four bytes of flags — ten bytes of chunk in all.
    if (!fits(10) || buffer.length < 30) return null;
    return valid(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
  }

  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, a 3-byte start code, then 14-bit dimensions
    // each sharing its uint16 with two scale bits — ten bytes of chunk.
    if (!fits(10) || buffer.length < 30) return null;
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
    if (!fits(5) || buffer.length < 25) return null;
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
