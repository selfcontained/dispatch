/**
 * Natural pixel dimensions read straight out of an image file's header.
 *
 * The chat feed reserves space for an image before it loads, so it needs the
 * aspect ratio at render time — which means the ratio has to be on the media
 * row, which means something has to read it when the row is written. That is
 * all this module does: read the handful of bytes that carry width and height
 * for the formats `isImageFile` accepts (PNG, JPEG, GIF, WebP).
 *
 * Dependency-free, and deliberately small. The governing rule is that **a
 * wrong answer is worse than no answer**: a bad ratio reserves a box the image
 * cannot fit, where `null` falls back to a fixed-height box that at least holds
 * still. Every entry point is total — anything unrecognised, truncated, or
 * malformed returns `null` rather than throwing, and an upload never fails
 * because its dimensions could not be read.
 *
 * ## EXIF is detected, not parsed
 *
 * A JPEG or PNG can carry an EXIF orientation tag, and orientations 5-8 include
 * a quarter turn: a browser's default `image-orientation: from-image` means a
 * 120x90 file tagged "rotate 90" reports `naturalWidth` 90. Reading the raw
 * header numbers for such a file would hand back a sideways ratio.
 *
 * Rather than parse the tag, this module *detects its presence* and declines to
 * answer. Working out whether a file might be rotated is a signature check;
 * working out how it is rotated means walking a TIFF IFD, and that is where
 * confident-wrong answers come from. Declining costs one image the fixed-height
 * box it would have had anyway before any of this existed, which is a far
 * cheaper failure than reserving the wrong shape.
 *
 * WebP is the exception: Chromium does not apply EXIF orientation to WebP, so
 * the VP8X canvas size is what gets laid out regardless.
 *
 * ## Buffers are complete
 *
 * Every caller passes the whole file — the upload route, `dispatch_share_file`,
 * agent startup media, browser-extension screenshots, and stream captures all
 * have the bytes in memory already. So "the walk ran off the end of the buffer"
 * means the file is truncated, not that we merely read too little of it, and
 * `null` is the right answer in both readings.
 */

export type ImageDimensions = { width: number; height: number };

/**
 * Largest value we will believe. Guards against a corrupt header.
 *
 * Exported because `media/metadata.ts` bounds the stored value by the same
 * number: this cap is what stops a bad header producing an absurd one, and the
 * schema's cap is what stops a hand-edited row doing the same. If the two ever
 * diverged a row could be writable but unreadable, so there is only one.
 */
export const MAX_DIMENSION = 100_000;

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
 * Whether a PNG carries an `eXIf` chunk: `true` if one is there, `false` if the
 * chunk list was walked to `IEND` without finding one, `null` if the walk could
 * not be completed and absence therefore cannot be claimed.
 *
 * The whole list is walked rather than stopping at `IDAT`, which is broader
 * than it strictly needs to be: measured against Chromium, an `eXIf` chunk
 * placed after the pixel data is *not* applied — a 120x90 PNG carrying a
 * post-`IDAT` orientation 6 still lays out 120x90, where the same tag before
 * `IDAT` lays out 90x120. So stopping at `IDAT` would also match the browser.
 *
 * Walking on anyway keeps the rule to one sentence — any `eXIf` at all and we
 * decline — and the cost of being broader is only that a rare file shape gets
 * the fallback box instead of a measured one. Declining is never wrong here;
 * answering can be.
 */
function pngCarriesExif(buffer: Buffer): boolean | null {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "eXIf") return true;
    if (type === "IEND") return false;
    // 4 bytes length, 4 type, `length` data, 4 CRC. Skipping needs only the
    // declared length, but the next header has to land inside the buffer.
    offset = offset + 8 + length + 4;
    if (offset > buffer.length) return null;
  }
  return null;
}

/**
 * PNG: IHDR is required to come first, so width and height sit at fixed offsets
 * 16 and 20 as big-endian uint32s.
 */
function pngDimensions(buffer: Buffer): ImageDimensions | null {
  // The whole IHDR chunk: 8 signature, 4 length, 4 type, 13 data, 4 CRC.
  if (buffer.length < 33) return null;
  // A missing IHDR means this is not a PNG we can trust the offsets for, and a
  // length other than 13 means the chunk claiming to own those bytes is not the
  // chunk we are about to read.
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  if (buffer.readUInt32BE(8) !== 13) return null;
  if (pngCarriesExif(buffer) !== false) return null;
  return valid(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
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
 * image's size. 0xC0-0xCF is the SOF range with three exceptions that reuse the
 * space for other tables (DHT, JPG, DAC).
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Whether an APP1 segment is an EXIF block.
 *
 * The full "Exif\0\0" signature, not just the four letters: XMP's APP1 opens
 * with a URI, and other vendors put their own tags in APP1 too. Only an EXIF
 * block can carry an orientation.
 */
function isExifApp1(buffer: Buffer, start: number, end: number): boolean {
  if (end - start < 6) return false;
  if (buffer.toString("ascii", start, start + 4) !== "Exif") return false;
  return buffer[start + 4] === 0x00 && buffer[start + 5] === 0x00;
}

/**
 * JPEG: walk the segment chain from SOI to the start of the scan, collecting
 * the frame size and noting whether any EXIF block appeared.
 *
 * The walk does not stop at the frame header even though that is where the
 * numbers are. Encoders may place an APP1 after the SOF and browsers honour it,
 * so stopping there would read the size and miss the rotation that invalidates
 * it. Metadata is only fully known once the scan begins.
 *
 * The walk is strict about structure. A byte that is not 0xFF where a marker
 * belongs means the chain is broken, and every byte after it is noise that can
 * still happen to look like a SOF — scanning ahead for one is how a parser comes
 * to report confident dimensions for a file that is not a JPEG at all.
 */
function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  let frame: { width: number; height: number } | null = null;

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
    // A segment running past what we hold means the file is truncated; there is
    // nothing trustworthy left to walk.
    if (segmentEnd > buffer.length) return null;

    // An EXIF block may rotate the image, and this module does not work out by
    // how much. Decline rather than answer with the unrotated numbers.
    if (marker === 0xe1 && isExifApp1(buffer, lengthAt + 2, segmentEnd)) {
      return null;
    }

    // Start of scan: metadata is complete, and the frame we collected is the
    // one the scan is about to encode. Its header is `Ns` components of two
    // bytes each, wrapped in six bytes of its own.
    if (marker === 0xda) {
      const components = buffer[lengthAt + 2]!;
      if (components < 1 || components > 4) return null;
      if (length !== 6 + components * 2) return null;
      return frame ? valid(frame.width, frame.height) : null;
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
  // so an EXIF block still ahead of us would have been missed.
  return null;
}

/**
 * WebP: a RIFF container whose first chunk says which of three encodings the
 * file uses, each storing its size differently.
 *
 * No EXIF check here. A VP8X file may carry an EXIF chunk, but Chromium does not
 * apply its orientation to WebP — the canvas size in the VP8X header is what
 * gets laid out.
 */
function webpDimensions(buffer: Buffer): ImageDimensions | null {
  // Through the first chunk's size field at offsets 16-19, which is read below.
  if (buffer.length < 20) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;

  const chunk = buffer.toString("ascii", 12, 16);
  const chunkSize = buffer.readUInt32LE(16);
  // The RIFF payload has to have room for "WEBP" plus this chunk's header and
  // body, or the container is lying about what it holds.
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
 * Natural dimensions of an image already in memory, or `null` when the bytes are
 * not a format we parse, the header does not hold up, or the file carries EXIF
 * that might rotate it.
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
