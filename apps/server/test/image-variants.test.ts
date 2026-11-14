import {
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { noisyPng } from "./helpers/noisy-png.js";

import {
  DEFAULT_MAX_PIXELS,
  ImageVariantCache,
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
