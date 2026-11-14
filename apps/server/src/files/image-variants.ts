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
 * SVG), images already narrow enough, images whose EXIF might rotate them,
 * inputs over the pixel cap, decode failures, a copy that came out no smaller
 * than its source, and any filesystem error. A `null` for a readable file is
 * remembered with an empty `.orig` marker so the next request does not decode
 * it again.
 *
 * ## Event-loop budget
 *
 * Decoding runs on the server's event loop. Generation is serialized through
 * one queue, concurrent requests for the same copy share one job, and inputs
 * above `DEFAULT_MAX_PIXELS` are never decoded (RGBA decode memory is 4 bytes
 * per pixel). Cache files are written to a temp name and renamed into place,
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

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { imageDimensionsFromBuffer } from "./image-dimensions.js";

/** The widths a caller may ask for. Anything else snaps to one of these. */
export const IMAGE_VARIANT_WIDTHS = [320, 640, 1280] as const;

/** ~40 megapixels: ~160MB of RGBA once decoded. Larger inputs get the original. */
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
  await removeStale(
    path.join(path.dirname(sourcePath), VARIANT_DIR_NAME),
    `${sourceKey(sourcePath)}.w`,
    null
  );
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
          (current === null || !name.startsWith(`${current}.`)) &&
          !name.includes(".tmp-")
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
  // Header check first: format, sane size, and no EXIF that a browser would
  // use to rotate the original (the decoders here would ignore it).
  const dims = imageDimensionsFromBuffer(input);
  if (!dims) return null;
  if (dims.width <= width) return null;
  if (dims.width * dims.height > maxPixels) return null;

  let decoded: { width: number; height: number; data: Uint8Array };
  if (isPngBytes(input)) {
    decoded = PNG.sync.read(input);
  } else if (input[0] === 0xff && input[1] === 0xd8) {
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

  if (opaque) {
    const encoded = jpeg.encode({ data: pixels, width, height }, JPEG_QUALITY);
    return { bytes: encoded.data, contentType: "image/jpeg" };
  }
  const png = new PNG({ width, height });
  pixels.copy(png.data);
  return {
    bytes: PNG.sync.write(png, { colorType: 6 }),
    contentType: "image/png",
  };
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
