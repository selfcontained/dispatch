import {
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { noisyPng } from "./helpers/noisy-png.js";

import {
  DEFAULT_MAX_PIXELS,
  ImageVariantCache,
  exifOrientation,
  iccProfileOf,
  type RenderedVariant,
  VARIANT_DIR_NAME,
  parseVariantWidth,
  removeImageVariants,
  renderImageVariant,
} from "../src/files/image-variants.js";

const root = path.join(os.tmpdir(), `image-variants-test-${process.pid}`);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let dir: string;
let counter = 0;
beforeEach(async () => {
  counter += 1;
  dir = path.join(root, `case-${counter}`);
  await mkdir(dir, { recursive: true });
});

/** `png` with a chunk inserted straight after IHDR. */
function withChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  const at = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

/** A minimal TIFF/EXIF block with one IFD0 entry: orientation, or none. */
function tiffWithOrientation(orientation: number | null, le = true): Buffer {
  const entries = orientation === null ? 0 : 1;
  const b = Buffer.alloc(8 + 2 + entries * 12 + 4);
  b.write(le ? "II" : "MM", 0, "latin1");
  const u16 = (v: number, at: number) =>
    le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at);
  const u32 = (v: number, at: number) =>
    le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at);
  u16(42, 2);
  u32(8, 4);
  u16(entries, 8);
  if (orientation !== null) {
    u16(0x0112, 10);
    u16(3, 12);
    u32(1, 14);
    u16(orientation, 18);
  }
  return b;
}

function fakeProfile(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function iccpChunk(profile: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from("Display P3\0\0", "latin1"),
    deflateSync(profile),
  ]);
}

/** A JPEG with `profile` split across APP2 segments, as cameras write it. */
function jpegWithProfile(jpegBytes: Buffer, profile: Buffer): Buffer {
  const marker = Buffer.from("ICC_PROFILE\0", "latin1");
  const max = 65_519;
  const count = Math.ceil(profile.length / max);
  const segments: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const part = profile.subarray(i * max, (i + 1) * max);
    const header = Buffer.from([0xff, 0xe2, 0, 0]);
    header.writeUInt16BE(2 + marker.length + 2 + part.length, 2);
    segments.push(header, marker, Buffer.from([i + 1, count]), part);
  }
  return Buffer.concat([
    jpegBytes.subarray(0, 2),
    ...segments,
    jpegBytes.subarray(2),
  ]);
}

async function store(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

async function variantFiles(): Promise<string[]> {
  return (
    await readdir(path.join(dir, VARIANT_DIR_NAME)).catch(() => [])
  ).sort();
}

describe("parseVariantWidth", () => {
  it("is undefined when no width was asked for", () => {
    expect(parseVariantWidth(undefined)).toBeUndefined();
  });

  it("snaps an unlisted width up to the next allowed one", () => {
    expect(parseVariantWidth("320")).toBe(320);
    expect(parseVariantWidth("1")).toBe(320);
    expect(parseVariantWidth("321")).toBe(640);
    expect(parseVariantWidth("1000")).toBe(1280);
  });

  it("clamps a width above the largest to the largest", () => {
    expect(parseVariantWidth("99999")).toBe(1280);
  });

  it.each(["", "0", "-5", "abc", "12.5", "1e3", "9999999"])(
    "rejects %j",
    (raw) => {
      expect(parseVariantWidth(raw)).toBeNull();
    }
  );

  it("rejects a repeated parameter", () => {
    expect(parseVariantWidth(["640", "320"])).toBeNull();
  });
});

describe("renderImageVariant", () => {
  it("shrinks an opaque PNG to the requested width as JPEG, keeping the aspect ratio", () => {
    const out = renderImageVariant(noisyPng(1600, 900), 640);
    expect(out?.contentType).toBe("image/jpeg");
    const decoded = jpeg.decode(out!.bytes, { useTArray: true });
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(360);
  });

  it("keeps transparency as PNG", () => {
    const out = renderImageVariant(
      noisyPng(800, 400, (x) => (x < 400 ? 0 : 255)),
      320
    );
    expect(out?.contentType).toBe("image/png");
    const decoded = PNG.sync.read(out!.bytes);
    expect([decoded.width, decoded.height]).toEqual([320, 160]);
    expect(decoded.data[3]).toBe(0); // left half stays transparent
    expect(decoded.data[(320 - 1) * 4 + 3]).toBe(255); // right half opaque
  });

  it("shrinks a JPEG", () => {
    const src = jpeg.encode(
      {
        data: PNG.sync.read(noisyPng(1000, 500)).data,
        width: 1000,
        height: 500,
      },
      95
    ).data;
    const out = renderImageVariant(src, 320);
    const decoded = jpeg.decode(out!.bytes, { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([320, 160]);
  });

  it("serves the original for an animated PNG", () => {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0);
    expect(
      renderImageVariant(withChunk(noisyPng(1000, 500), "acTL", actl), 320)
    ).toBeNull();
  });

  it("carries a PNG's ICC profile into a JPEG copy", () => {
    const profile = fakeProfile(3144);
    const src = withChunk(noisyPng(1000, 500), "iCCP", iccpChunk(profile));
    expect(iccProfileOf(src)).toEqual(profile);
    const out = renderImageVariant(src, 320);
    expect(out?.contentType).toBe("image/jpeg");
    expect(iccProfileOf(out!.bytes)).toEqual(profile);
    expect(jpeg.decode(out!.bytes, { useTArray: true }).width).toBe(320);
  });

  it("carries a PNG's ICC profile into a transparent PNG copy", () => {
    const profile = fakeProfile(3144);
    const src = withChunk(
      noisyPng(800, 400, (x) => (x < 400 ? 0 : 255)),
      "iCCP",
      iccpChunk(profile)
    );
    const out = renderImageVariant(src, 320);
    expect(out?.contentType).toBe("image/png");
    expect(iccProfileOf(out!.bytes)).toEqual(profile);
    // pngjs verifies every chunk CRC on read.
    expect(PNG.sync.read(out!.bytes).width).toBe(320);
  });

  it("carries a multi-segment JPEG ICC profile into the copy", () => {
    const profile = fakeProfile(70_000);
    const base = jpeg.encode(
      {
        data: PNG.sync.read(noisyPng(1000, 500)).data,
        width: 1000,
        height: 500,
      },
      95
    ).data;
    const src = jpegWithProfile(base, profile);
    expect(iccProfileOf(src)).toEqual(profile);
    const out = renderImageVariant(src, 320);
    expect(iccProfileOf(out!.bytes)).toEqual(profile);
    expect(jpeg.decode(out!.bytes, { useTArray: true }).width).toBe(320);
  });

  it("serves the original when the ICC chunk is unreadable", () => {
    const bad = Buffer.concat([
      Buffer.from("P3\0\0", "latin1"),
      Buffer.from("not zlib"),
    ]);
    expect(
      renderImageVariant(withChunk(noisyPng(1000, 500), "iCCP", bad), 320)
    ).toBeNull();
  });

  it("resizes a macOS-style screenshot carrying upright EXIF and a P3 profile", () => {
    const profile = fakeProfile(536);
    const src = withChunk(
      withChunk(noisyPng(1000, 500), "eXIf", tiffWithOrientation(1)),
      "iCCP",
      iccpChunk(profile)
    );
    const out = renderImageVariant(src, 320);
    expect(out?.contentType).toBe("image/jpeg");
    expect(iccProfileOf(out!.bytes)).toEqual(profile);
  });

  it("resizes a PNG whose EXIF has no orientation tag", () => {
    expect(
      renderImageVariant(
        withChunk(noisyPng(1000, 500), "eXIf", tiffWithOrientation(null)),
        320
      )
    ).not.toBeNull();
  });

  it.each([3, 6, 8])("serves the original for EXIF orientation %i", (o) => {
    expect(
      renderImageVariant(
        withChunk(noisyPng(1000, 500), "eXIf", tiffWithOrientation(o)),
        320
      )
    ).toBeNull();
  });

  it("serves the original for unreadable EXIF", () => {
    expect(
      renderImageVariant(
        withChunk(noisyPng(1000, 500), "eXIf", Buffer.from("garbage!")),
        320
      )
    ).toBeNull();
  });

  it("reads orientation from a JPEG's EXIF segment", () => {
    const base = jpeg.encode(
      {
        data: PNG.sync.read(noisyPng(1000, 500)).data,
        width: 1000,
        height: 500,
      },
      95
    ).data;
    const withExif = (o: number) => {
      const body = Buffer.concat([
        Buffer.from("Exif\0\0", "latin1"),
        tiffWithOrientation(o),
      ]);
      const header = Buffer.from([0xff, 0xe1, 0, 0]);
      header.writeUInt16BE(body.length + 2, 2);
      return Buffer.concat([
        base.subarray(0, 2),
        header,
        body,
        base.subarray(2),
      ]);
    };
    expect(renderImageVariant(withExif(1), 320)).not.toBeNull();
    expect(renderImageVariant(withExif(6), 320)).toBeNull();
  });

  it("parses big-endian TIFF too", () => {
    expect(exifOrientation(tiffWithOrientation(6, false))).toBe(6);
    expect(exifOrientation(tiffWithOrientation(1, false))).toBe(1);
  });

  it("declines an image already no wider than the target", () => {
    expect(renderImageVariant(noisyPng(640, 100), 640)).toBeNull();
  });

  it("declines an input over the pixel cap without decoding it", () => {
    expect(DEFAULT_MAX_PIXELS).toBe(40_000_000);
    expect(
      renderImageVariant(noisyPng(400, 300), 320, 400 * 300 - 1)
    ).toBeNull();
  });

  it("declines formats it does not resize", () => {
    expect(
      renderImageVariant(Buffer.from("GIF89a\x10\x00\x10\x00"), 320)
    ).toBeNull();
    expect(renderImageVariant(Buffer.from("<svg/>"), 320)).toBeNull();
  });
});

describe("ImageVariantCache", () => {
  it("writes a resized copy beside the original and reuses it without re-encoding", async () => {
    const cache = new ImageVariantCache();
    const file = await store("shot.png", noisyPng(1600, 900));

    const first = await cache.get(file, "image/png", 640);
    expect(first?.contentType).toBe("image/jpeg");
    expect(path.dirname(first!.path)).toBe(path.join(dir, VARIANT_DIR_NAME));
    expect(cache.renders).toBe(1);

    const second = await cache.get(file, "image/png", 640);
    expect(second).toEqual(first);
    expect(cache.renders).toBe(1);

    // A fresh cache (server restart) reads the disk copy too.
    const restarted = new ImageVariantCache();
    expect(await restarted.get(file, "image/png", 640)).toEqual(first);
    expect(restarted.renders).toBe(0);
  });

  it("shares one job between concurrent requests for the same copy", async () => {
    const cache = new ImageVariantCache();
    const file = await store("shot.png", noisyPng(1600, 900));
    const results = await Promise.all([
      cache.get(file, "image/png", 640),
      cache.get(file, "image/png", 640),
      cache.get(file, "image/png", 640),
    ]);
    expect(cache.renders).toBe(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("generates one copy at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const cache = new ImageVariantCache({
      render: async (
        input,
        width,
        maxPixels
      ): Promise<RenderedVariant | null> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return renderImageVariant(input, width, maxPixels);
      },
    });
    const a = await store("a.png", noisyPng(1400, 700));
    const b = await store("b.png", noisyPng(1400, 700));
    await Promise.all([
      cache.get(a, "image/png", 320),
      cache.get(a, "image/png", 640),
      cache.get(b, "image/png", 320),
      cache.get(b, "image/png", 1280),
    ]);
    expect(cache.renders).toBe(4);
    expect(maxActive).toBe(1);
  });

  it("serves the original for an input over the pixel cap, and remembers that", async () => {
    const cache = new ImageVariantCache({ maxPixels: 1000 * 500 - 1 });
    const file = await store("big.png", noisyPng(1000, 500));
    expect(await cache.get(file, "image/png", 320)).toBeNull();
    expect(await cache.get(file, "image/png", 320)).toBeNull();
    expect(cache.renders).toBe(1);
  });

  it("serves the original for formats it does not resize, without decoding", async () => {
    const cache = new ImageVariantCache();
    const gif = await store("anim.gif", Buffer.from("GIF89a\x10\x00\x10\x00"));
    const svg = await store("logo.svg", Buffer.from("<svg/>"));
    expect(await cache.get(gif, "image/gif", 320)).toBeNull();
    expect(await cache.get(svg, "image/svg+xml", 320)).toBeNull();
    expect(cache.renders).toBe(0);
  });

  it("serves the original when decoding fails", async () => {
    const cache = new ImageVariantCache();
    const good = noisyPng(1000, 500);
    // Valid header, garbage image data.
    const broken = Buffer.concat([good.subarray(0, 64), Buffer.alloc(4096, 7)]);
    const file = await store("broken.png", broken);
    expect(await cache.get(file, "image/png", 320)).toBeNull();
  });

  it("serves the original when the renderer throws", async () => {
    const cache = new ImageVariantCache({
      render: () => {
        throw new Error("boom");
      },
    });
    const file = await store("shot.png", noisyPng(1000, 500));
    expect(await cache.get(file, "image/png", 320)).toBeNull();
  });

  it("writes atomically: a failed write leaves no copy and no temp file", async () => {
    const cache = new ImageVariantCache({
      fs: {
        writeFile: async (target, data) => {
          await writeFile(target, data.subarray(0, 10));
          throw new Error("disk full");
        },
        rename: async () => {
          throw new Error("unreachable");
        },
      },
    });
    const file = await store("shot.png", noisyPng(1000, 500));
    expect(await cache.get(file, "image/png", 320)).toBeNull();
    expect(await variantFiles()).toEqual([]);
  });

  it("only ever exposes a complete copy under its final name", async () => {
    const renames: Array<[string, string]> = [];
    const cache = new ImageVariantCache({
      fs: {
        writeFile: (target, data) => writeFile(target, data),
        rename: async (from, to) => {
          renames.push([from, to]);
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      },
    });
    const file = await store("shot.png", noisyPng(1000, 500));
    const variant = await cache.get(file, "image/png", 320);
    expect(renames).toHaveLength(1);
    expect(renames[0]![1]).toBe(variant!.path);
    expect(renames[0]![0]).toMatch(/\.tmp-/);
    const decoded = jpeg.decode(await readFile(variant!.path), {
      useTArray: true,
    });
    expect(decoded.width).toBe(320);
    expect((await variantFiles()).some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("makes a new copy when the file changes, and drops the old one", async () => {
    const cache = new ImageVariantCache();
    const file = await store("shot.png", noisyPng(1000, 500));
    const first = await cache.get(file, "image/png", 320);
    await writeFile(file, noisyPng(1200, 400));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);

    const second = await cache.get(file, "image/png", 320);
    expect(second!.etag).not.toBe(first!.etag);
    expect(second!.path).not.toBe(first!.path);
    expect(await variantFiles()).toEqual([path.basename(second!.path)]);
  });

  it("leaves no copy behind when the file is deleted mid-render", async () => {
    let file = "";
    const cache = new ImageVariantCache({
      render: async (input, width, maxPixels) => {
        await unlink(file);
        await removeImageVariants(file);
        return renderImageVariant(input, width, maxPixels);
      },
    });
    file = await store("shot.png", noisyPng(1000, 500));
    expect(await cache.get(file, "image/png", 320)).toBeNull();
    expect(await variantFiles()).toEqual([]);
  });

  it("reaps temp files a crash left behind", async () => {
    const cache = new ImageVariantCache();
    const file = await store("shot.png", noisyPng(1000, 500));
    const first = await cache.get(file, "image/png", 320);
    const orphan = `${first!.path}.tmp-999-deadbeef`;
    await writeFile(orphan, "partial");
    await removeImageVariants(file);
    expect(await variantFiles()).toEqual([]);
  });

  it("removeImageVariants deletes every copy of one file and nothing else", async () => {
    const cache = new ImageVariantCache();
    const a = await store("a.png", noisyPng(1400, 700));
    const b = await store("b.png", noisyPng(1400, 700));
    await cache.get(a, "image/png", 320);
    await cache.get(a, "image/png", 640);
    const keep = await cache.get(b, "image/png", 320);
    await removeImageVariants(a);
    expect(await variantFiles()).toEqual([path.basename(keep!.path)]);
  });
});
