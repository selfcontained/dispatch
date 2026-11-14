/**
 * Display-sized copies of stored images, made on first request and cached on
 * disk beside the originals.
 *
 * Previews in the UI are a few hundred CSS pixels wide, but screenshots arrive
 * at 2-4k wide. `GET /api/v1/agents/:id/files/:file?w=640` asks for a copy
 * that fits; everything else keeps getting the original.
 *
 * ## Pure JS on purpose
 *
 * The server ships as a `bun build --compile` binary cross-compiled for macOS
 * and Linux from one macOS runner. Native image libraries (sharp/libvips)
 * load a separate shared library at runtime and only install for the host
 * platform, so they cannot ride along in that binary. `pngjs` and `jpeg-js`
 * are plain JavaScript and bundle into every target unchanged.
 *
 * ## Never break the image
 *
 * Every path that cannot produce a strictly better copy answers `null`, and
 * the caller serves the original: formats other than PNG/JPEG (GIF, WebP,
 * SVG), animated PNGs, images already narrow enough, images whose EXIF
 * orientation isn't upright (or can't be read), inputs over the pixel cap, decode failures, a copy that came out no smaller
 * than its source, and any filesystem error. A `null` for a readable file is
 * remembered with an empty `.orig` marker so the next request does not decode
 * it again.
 *
 * An embedded ICC colour profile is copied into the resized image (iCCP for
 * PNG, APP2 for JPEG). Without it a Display P3 screenshot, which is what macOS
 * produces, would be read as sRGB and look washed out next to the original.
 *
 * ## Event-loop budget
 *
 * Decoding runs on the server's event loop. Generation is serialized through
 * one queue, concurrent requests for the same copy share one job, and inputs
 * above `DEFAULT_MAX_PIXELS` are never decoded (see there for the memory
 * budget). Cache files are written to a temp name and renamed into place,
 * so a crash cannot leave a half-written thumbnail behind.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { imageDimensionsFromBuffer } from "./image-dimensions.js";

/** The widths a caller may ask for. Anything else snaps to one of these. */
export const IMAGE_VARIANT_WIDTHS = [320, 640, 1280] as const;

/**
 * ~40 megapixels. Larger inputs get the original. Decoding one at this size
 * peaks around 300-400MB: the inflated scanlines (~4 bytes/pixel) plus the
 * RGBA buffer (4 bytes/pixel), on top of the input file. The queue keeps it
 * to one decode at a time.
 */
export const DEFAULT_MAX_PIXELS = 40_000_000;

/** Files bigger than this are not read into memory to be decoded. */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const JPEG_QUALITY = 82;

/** Directory, beside the originals, that holds their copies. */
export const VARIANT_DIR_NAME = ".thumbnails";

/**
 * `undefined` when no width was asked for, `null` when the value is not a
 * positive integer, otherwise the smallest allowed width at least as large
 * as the request (capped at the largest).
 */
export function parseVariantWidth(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return null;
  const requested = Number(raw);
  if (requested <= 0) return null;
  for (const width of IMAGE_VARIANT_WIDTHS) {
    if (width >= requested) return width;
  }
  return IMAGE_VARIANT_WIDTHS[IMAGE_VARIANT_WIDTHS.length - 1]!;
}

export type ImageVariant = {
  path: string;
  contentType: "image/jpeg" | "image/png";
  /** Strong validator: source version plus width. */
  etag: string;
};

export type RenderedVariant = {
  bytes: Buffer;
  contentType: "image/jpeg" | "image/png";
};

type Renderer = (
  input: Buffer,
  width: number,
  maxPixels: number
) => RenderedVariant | null | Promise<RenderedVariant | null>;

type VariantFs = {
  writeFile: (file: string, data: Buffer) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
};

export type ImageVariantCacheOptions = {
  maxPixels?: number;
  /** Swappable for tests; defaults to `renderImageVariant`. */
  render?: Renderer;
  /** Swappable for tests; defaults to node:fs/promises. */
  fs?: VariantFs;
};

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

export class ImageVariantCache {
  /** How many times a copy has been rendered. Tests read it. */
  renders = 0;

  private readonly maxPixels: number;
  private readonly render: Renderer;
  private readonly fs: VariantFs;
  private readonly inflight = new Map<string, Promise<ImageVariant | null>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ImageVariantCacheOptions = {}) {
    this.maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
    this.render = options.render ?? renderImageVariant;
    this.fs = options.fs ?? { writeFile, rename };
  }

  /**
   * The cached copy of `sourcePath` at `width`, generating it if needed, or
   * `null` when the original should be served instead.
   */
  async get(
    sourcePath: string,
    mimeType: string | undefined,
    width: number
  ): Promise<ImageVariant | null> {
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;

    const sourceStat = await stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) return null;
    if (sourceStat.size === 0 || sourceStat.size > MAX_INPUT_BYTES) {
      return null;
    }

    const version = `${Math.trunc(sourceStat.mtimeMs)}-${sourceStat.size}`;
    const dir = path.join(path.dirname(sourcePath), VARIANT_DIR_NAME);
    const prefix = `${sourceKey(sourcePath)}.w${width}.`;
    const base = path.join(dir, `${prefix}${version}`);
    const etag = `"${version}-w${width}"`;

    // Registered before the next await, so every concurrent caller for this
    // copy gets the same promise.
    const existing = this.inflight.get(base);
    if (existing) return existing;

    const job = (async () => {
      const cached = await findCached(base, etag);
      if (cached !== undefined) return cached;
      return this.enqueue(() =>
        this.generate(sourcePath, dir, prefix, base, etag, width)
      );
    })().finally(() => {
      this.inflight.delete(base);
    });
    this.inflight.set(base, job);
    return job;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async generate(
    sourcePath: string,
    dir: string,
    prefix: string,
    base: string,
    etag: string,
    width: number
  ): Promise<ImageVariant | null> {
    // Another job may have finished this copy while we waited in the queue.
    const cached = await findCached(base, etag);
    if (cached !== undefined) return cached;

    let input: Buffer;
    try {
      input = await readFile(sourcePath);
    } catch {
      return null;
    }

    let rendered: RenderedVariant | null = null;
    try {
      this.renders += 1;
      rendered = await this.render(input, width, this.maxPixels);
    } catch {
      rendered = null;
    }
    // A copy no smaller than its source helps nobody.
    if (rendered && rendered.bytes.length >= input.length) rendered = null;

    try {
      await mkdir(dir, { recursive: true });
      const target = rendered
        ? `${base}.${EXTENSIONS[rendered.contentType]}`
        : `${base}.orig`;
      await this.writeAtomic(target, rendered?.bytes ?? Buffer.alloc(0));
      // A delete that ran while this job was rendering has already swept
      // the cache, so a copy written after it would never be cleaned up.
      // Checking after the rename closes the gap: a delete that comes later
      // sweeps this copy too.
      if (!(await sourceMatches(sourcePath, base))) {
        await rm(target, { force: true });
        return null;
      }
      await removeStale(dir, prefix, path.basename(base));
      return rendered
        ? { path: target, contentType: rendered.contentType, etag }
        : null;
    } catch {
      return null;
    }
  }

  private async writeAtomic(target: string, bytes: Buffer): Promise<void> {
    const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await this.fs.writeFile(temp, bytes);
      await this.fs.rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** Whether the source still exists at the version `base` was made from. */
async function sourceMatches(
  sourcePath: string,
  base: string
): Promise<boolean> {
  const current = await stat(sourcePath).catch(() => null);
  if (!current?.isFile()) return false;
  return base.endsWith(`.${Math.trunc(current.mtimeMs)}-${current.size}`);
}

/** Short, filesystem-safe stand-in for a stored file's name. */
function sourceKey(sourcePath: string): string {
  return createHash("sha256")
    .update(path.basename(sourcePath))
    .digest("hex")
    .slice(0, 24);
}

/**
 * `ImageVariant` for a cached copy, `null` for a cached "serve the original"
 * decision, `undefined` when nothing is cached yet.
 */
async function findCached(
  base: string,
  etag: string
): Promise<ImageVariant | null | undefined> {
  for (const [contentType, ext] of Object.entries(EXTENSIONS) as Array<
    [ImageVariant["contentType"], string]
  >) {
    const candidate = `${base}.${ext}`;
    const found = await stat(candidate).catch(() => null);
    if (found?.isFile()) return { path: candidate, contentType, etag };
  }
  const marker = await stat(`${base}.orig`).catch(() => null);
  return marker?.isFile() ? null : undefined;
}

/** Remove every cached copy of a stored file. Never throws. */
export async function removeImageVariants(sourcePath: string): Promise<void> {
  // Cleanup must never fail the delete that called it.
  try {
    await removeStale(
      path.join(path.dirname(sourcePath), VARIANT_DIR_NAME),
      `${sourceKey(sourcePath)}.w`,
      null
    );
  } catch {
    // Leftover copies are harmless: keyed by name and version.
  }
}

/** Drop copies of the same file and width made from an older version. */
async function removeStale(
  dir: string,
  prefix: string,
  current: string | null
): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          // Generation is serialized, so when this runs (inside the queue,
          // or on delete) any temp file for this key is one a crash left.
          (current === null ||
            !name.startsWith(`${current}.`) ||
            name.includes(".tmp-"))
      )
      .map((name) => rm(path.join(dir, name), { force: true }).catch(() => {}))
  );
}

/**
 * Decode, shrink to `width` keeping the aspect ratio, and re-encode: JPEG for
 * opaque images, PNG when any pixel is transparent. `null` when the input is
 * not worth or not safe to resize.
 */
export function renderImageVariant(
  input: Buffer,
  width: number,
  maxPixels: number = DEFAULT_MAX_PIXELS
): RenderedVariant | null {
  // Header check first: format and sane size. EXIF is checked separately
  // below, by reading its orientation rather than refusing any EXIF at all:
  // macOS writes an eXIf chunk (orientation 1) into every screenshot.
  const dims = imageDimensionsFromBuffer(input, {
    ignoreExifOrientation: true,
  });
  if (!dims) return null;
  if (dims.width <= width) return null;
  if (dims.width * dims.height > maxPixels) return null;

  let decoded: { width: number; height: number; data: Uint8Array };
  let icc: Buffer | null;
  if (isPngBytes(input)) {
    const chunks = pngChunks(input);
    if (!chunks) return null;
    // APNG: the decoder only sees the first frame, and a still copy would
    // stop a preview that animated before.
    if (chunks.some((c) => c.type === "acTL")) return null;
    // A browser would turn the original by its EXIF orientation; the
    // decoders here would not, so only upright images get a copy.
    const exif = chunks.find((c) => c.type === "eXIf");
    if (exif && exifOrientation(exif.data) !== 1) return null;
    const iccp = chunks.find((c) => c.type === "iCCP");
    icc = iccp ? pngIccProfile(iccp.data) : null;
    if (iccp && !icc) return null;
    decoded = PNG.sync.read(input);
  } else if (input[0] === 0xff && input[1] === 0xd8) {
    const exif = jpegExif(input);
    if (exif !== undefined && (exif === null || exifOrientation(exif) !== 1)) {
      return null;
    }
    icc = jpegIccProfile(input);
    decoded = jpeg.decode(input, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: Math.ceil(maxPixels / 1_000_000),
      maxMemoryUsageInMB: Math.ceil((maxPixels * 4 * 1.5) / (1024 * 1024)),
    });
  } else {
    return null;
  }
  if (decoded.width !== dims.width || decoded.height !== dims.height) {
    return null;
  }

  const height = Math.max(
    1,
    Math.round((decoded.height * width) / decoded.width)
  );
  const opaque = isOpaque(decoded.data);
  const pixels = resizeArea(decoded, width, height, !opaque);

  // The colour profile travels with the copy: a Display P3 screenshot read
  // as sRGB looks washed out next to its original.
  if (opaque) {
    const encoded = jpeg.encode({ data: pixels, width, height }, JPEG_QUALITY);
    return {
      bytes: icc ? withJpegIccProfile(encoded.data, icc) : encoded.data,
      contentType: "image/jpeg",
    };
  }
  const png = new PNG({ width, height });
  pixels.copy(png.data);
  const bytes = PNG.sync.write(png, { colorType: 6 });
  return {
    bytes: icc ? withPngIccProfile(bytes, icc) : bytes,
    contentType: "image/png",
  };
}

/** The ICC profile embedded in a PNG or JPEG, if any. */
export function iccProfileOf(buffer: Buffer): Buffer | null {
  if (isPngBytes(buffer)) {
    const iccp = pngChunks(buffer)?.find((c) => c.type === "iCCP");
    return iccp ? pngIccProfile(iccp.data) : null;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegIccProfile(buffer);
  return null;
}

/**
 * The EXIF orientation (1-8) in a TIFF-structured EXIF block, 1 when IFD0 has
 * no orientation tag, or `null` when the block doesn't hold up. Only IFD0 is
 * read: that is where orientation lives.
 */
export function exifOrientation(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (at: number) =>
    le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) =>
    le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > tiff.length) return null;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) !== 0x0112) continue;
    // SHORT, one value, stored in the first two bytes of the value field.
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return 1;
}

/**
 * The TIFF block of a JPEG's EXIF APP1 segment: `undefined` when there is
 * none, `null` when the segment walk doesn't hold up.
 */
function jpegExif(buffer: Buffer): Buffer | null | undefined {
  const header = Buffer.from("Exif\0\0", "latin1");
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    const body = buffer.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe1 && body.subarray(0, 6).equals(header)) {
      return body.subarray(6);
    }
    offset += 2 + length;
  }
  return null;
}

type PngChunk = { type: string; data: Buffer };

/** Every chunk up to IEND, or `null` when the chunk list doesn't hold up. */
function pngChunks(buffer: Buffer): PngChunk[] | null {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    chunks.push({
      type,
      data: buffer.subarray(offset + 8, offset + 8 + length),
    });
    if (type === "IEND") return chunks;
    offset = end;
  }
  return null;
}

/** The ICC bytes inside an iCCP chunk: name, NUL, method 0, zlib data. */
function pngIccProfile(data: Buffer): Buffer | null {
  const nul = data.indexOf(0);
  if (nul < 1 || nul > 79 || data[nul + 1] !== 0) return null;
  try {
    return inflateSync(data.subarray(nul + 2));
  } catch {
    return null;
  }
}

const ICC_MARKER = Buffer.from("ICC_PROFILE\0", "latin1");
/** APP2 payload room after the marker, sequence and count bytes. */
const ICC_SEGMENT_MAX = 65_535 - 2 - ICC_MARKER.length - 2;

/** A JPEG's ICC profile, reassembled from its APP2 segments in order. */
function jpegIccProfile(buffer: Buffer): Buffer | null {
  const parts = new Map<number, Buffer>();
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // image data / end
    const length = buffer.readUInt16BE(offset + 2);
    const body = buffer.subarray(offset + 4, offset + 2 + length);
    if (
      marker === 0xe2 &&
      body.length > ICC_MARKER.length + 2 &&
      body.subarray(0, ICC_MARKER.length).equals(ICC_MARKER)
    ) {
      parts.set(body[ICC_MARKER.length]!, body.subarray(ICC_MARKER.length + 2));
    }
    offset += 2 + length;
  }
  if (parts.size === 0) return null;
  const ordered: Buffer[] = [];
  for (let seq = 1; seq <= parts.size; seq++) {
    const part = parts.get(seq);
    if (!part) return null;
    ordered.push(part);
  }
  return Buffer.concat(ordered);
}

/** `jpegBytes` with `icc` as APP2 segments after SOI and any APP0. */
function withJpegIccProfile(jpegBytes: Buffer, icc: Buffer): Buffer {
  const count = Math.ceil(icc.length / ICC_SEGMENT_MAX);
  const segments: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const part = icc.subarray(i * ICC_SEGMENT_MAX, (i + 1) * ICC_SEGMENT_MAX);
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = 0xe2;
    header.writeUInt16BE(2 + ICC_MARKER.length + 2 + part.length, 2);
    segments.push(header, ICC_MARKER, Buffer.from([i + 1, count]), part);
  }
  let insertAt = 2;
  if (jpegBytes[2] === 0xff && jpegBytes[3] === 0xe0) {
    insertAt = 4 + jpegBytes.readUInt16BE(4);
  }
  return Buffer.concat([
    jpegBytes.subarray(0, insertAt),
    ...segments,
    jpegBytes.subarray(insertAt),
  ]);
}

/** `pngBytes` with an iCCP chunk carrying `icc`, right after IHDR. */
function withPngIccProfile(pngBytes: Buffer, icc: Buffer): Buffer {
  const data = Buffer.concat([
    Buffer.from("icc\0\0", "latin1"),
    deflateSync(icc),
  ]);
  const typeAndData = Buffer.concat([Buffer.from("iCCP", "latin1"), data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  const afterIhdr = 8 + 12 + pngBytes.readUInt32BE(8);
  return Buffer.concat([
    pngBytes.subarray(0, afterIhdr),
    chunk,
    pngBytes.subarray(afterIhdr),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPngBytes(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.readUInt32BE(4) === 0x0d0a1a0a
  );
}

function isOpaque(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return false;
  }
  return true;
}

type Contributions = { start: Int32Array; weights: Float32Array[] };

/** Per output index: the source span it averages over, and each cell's share. */
function contributions(srcLen: number, dstLen: number): Contributions {
  const scale = srcLen / dstLen;
  const start = new Int32Array(dstLen);
  const weights: Float32Array[] = [];
  for (let i = 0; i < dstLen; i++) {
    const lo = i * scale;
    const hi = Math.min(srcLen, (i + 1) * scale);
    const first = Math.floor(lo);
    const last = Math.min(srcLen - 1, Math.ceil(hi) - 1);
    const w = new Float32Array(last - first + 1);
    for (let s = first; s <= last; s++) {
      w[s - first] = (Math.min(hi, s + 1) - Math.max(lo, s)) / scale;
    }
    start[i] = first;
    weights.push(w);
  }
  return { start, weights };
}

/**
 * Area-average downscale: each output pixel is the coverage-weighted mean of
 * the source pixels under it. Rows are resampled horizontally one at a time
 * and accumulated into the output, so memory beyond the output is one row.
 * With `premultiply`, colour is weighted by alpha so transparent pixels do
 * not bleed their (meaningless) colour into the edges.
 */
function resizeArea(
  src: { width: number; height: number; data: Uint8Array },
  dw: number,
  dh: number,
  premultiply: boolean
): Buffer {
  const sw = src.width;
  const sh = src.height;
  const data = src.data;
  const cols = contributions(sw, dw);
  const scaleY = sh / dh;
  const acc = new Float32Array(dw * dh * 4);
  const row = new Float32Array(dw * 4);

  for (let sy = 0; sy < sh; sy++) {
    const rowBase = sy * sw * 4;
    for (let dx = 0; dx < dw; dx++) {
      const w = cols.weights[dx]!;
      let p = rowBase + cols.start[dx]! * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < w.length; k++, p += 4) {
        const wk = w[k]!;
        const alpha = data[p + 3]!;
        const m = premultiply ? (wk * alpha) / 255 : wk;
        r += data[p]! * m;
        g += data[p + 1]! * m;
        b += data[p + 2]! * m;
        a += alpha * wk;
      }
      const o = dx * 4;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      row[o + 3] = a;
    }

    const firstDy = Math.floor(sy / scaleY);
    const lastDy = Math.min(dh - 1, Math.floor((sy + 1) / scaleY));
    for (let dy = firstDy; dy <= lastDy; dy++) {
      const overlap =
        Math.min(sy + 1, (dy + 1) * scaleY) - Math.max(sy, dy * scaleY);
      if (overlap <= 0) continue;
      const wy = overlap / scaleY;
      const outBase = dy * dw * 4;
      for (let i = 0; i < dw * 4; i++) acc[outBase + i]! += row[i]! * wy;
    }
  }

  const out = Buffer.alloc(dw * dh * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = acc[i + 3]!;
    if (premultiply) {
      const k = a > 0 ? 255 / a : 0;
      out[i] = clampByte(acc[i]! * k);
      out[i + 1] = clampByte(acc[i + 1]! * k);
      out[i + 2] = clampByte(acc[i + 2]! * k);
    } else {
      out[i] = clampByte(acc[i]!);
      out[i + 1] = clampByte(acc[i + 1]!);
      out[i + 2] = clampByte(acc[i + 2]!);
    }
    out[i + 3] = clampByte(a);
  }
  return out;
}

function clampByte(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
}
