/**
 * Per-type metadata for a media row.
 *
 * `media` holds screenshots, video, PDFs and text side by side, so an attribute
 * that only means something for one of them does not belong in its own column.
 * `media.metadata` is one JSONB bag for all of it, and each writer fills in the
 * keys its file type actually has.
 *
 * Two rules keep that from becoming a junk drawer:
 *
 *  1. **Shared concepts share a key.** `width`/`height` mean the same thing for
 *     a PNG, a GIF and (one day) an mp4, so all of them write those two keys
 *     rather than `imageWidth` / `videoWidth`. Whatever reserves layout space
 *     reads one shape and does not care what the file is.
 *  2. **Reads go through `parseMediaMetadata`.** A typo in a jsonb key is
 *     invisible — it reads back as absent, the feed falls back to a fixed box,
 *     and nothing complains. Parsing at the boundary turns that into a failure
 *     a test can catch.
 *
 * Unknown keys survive a round-trip, so a writer that records something this
 * module has not been taught about does not lose it.
 */

import * as z from "zod/v4";

import { imageDimensionsFromBuffer } from "./image-dimensions.js";

const dimension = z.number().int().positive().max(100_000);

const MediaMetadataSchema = z
  .object({
    /**
     * Natural pixel size of a visual file, when it could be read. The chat feed
     * reserves a box of this aspect ratio before the image loads, so an
     * arriving image never pushes the reader's place down the page.
     */
    width: dimension.optional(),
    height: dimension.optional(),
  })
  .loose();

export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

/** Metadata as stored for a row that has none. */
export const EMPTY_MEDIA_METADATA: MediaMetadata = {};

/**
 * Read a `media.metadata` value into a shape the rest of the server can trust.
 *
 * Total, like everything else on this path: a row holding null, a scalar, an
 * array, or a `width` that is not a positive integer comes back as `{}` rather
 * than throwing. A malformed row should render in the fallback box, not fail
 * the page it appears on.
 */
export function parseMediaMetadata(value: unknown): MediaMetadata {
  const parsed = MediaMetadataSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // A width without a height (or either one malformed) is not a usable ratio,
  // so there is nothing to salvage from a partial match.
  return EMPTY_MEDIA_METADATA;
}

/**
 * The `width`/`height` pair as the wire shape wants it: present only when both
 * are known, so a consumer can test one field and trust the pair.
 */
export function dimensionFields(metadata: MediaMetadata): {
  width?: number;
  height?: number;
} {
  const { width, height } = metadata;
  return width !== undefined && height !== undefined ? { width, height } : {};
}

/**
 * Metadata for a file about to be stored, derived from the bytes being written.
 *
 * Dimensions come from the buffer rather than the file on disk, so this is pure
 * and costs no I/O — the numbers describe exactly the bytes the caller is about
 * to write, which is what keeps a row from ever disagreeing with its file.
 *
 * A file we cannot measure — a PDF, a video, an unreadable header, an image
 * carrying EXIF — gets `{}` and renders in the fixed-height fallback box.
 */
export function mediaMetadataFromBuffer(buffer: Buffer): MediaMetadata {
  const dimensions = imageDimensionsFromBuffer(buffer);
  return dimensions
    ? { width: dimensions.width, height: dimensions.height }
    : EMPTY_MEDIA_METADATA;
}
