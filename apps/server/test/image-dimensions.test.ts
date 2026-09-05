import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  imageDimensionsFromBuffer,
  probeImageFile,
} from "../src/media/image-dimensions.js";

/**
 * Real encoder output, not hand-built headers: each buffer below came out of
 * an encoder at the dimensions its name states. A parser that only ever sees
 * bytes we wrote ourselves proves nothing about the files agents upload.
 */
const PNG_37x19 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACUAAAATCAIAAACY31PkAAAACXBIWXMAAAPoAAAD6AG1" +
    "e1JrAAAALElEQVR4nGM4EaBBT8Qwal/AaHieGE0vGqP54cRo+aIxWn4GjNYPGsOnvgUA" +
    "48pu7rw5XfcAAAAASUVORK5CYII=",
  "base64"
);

const JPEG_64x41 = Buffer.from(
  "/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi" +
    "MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7" +
    "Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAApAEADASIA" +
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA" +
    "/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMB" +
    "AAIRAxEAPwCEBPrIAAAAAAAAAAAAAAAAAAAAAB//2Q==",
  "base64"
);

const GIF_23x71 = Buffer.from(
  "R0lGODlhFwBHAIAAAExpcchQKCH5BAUAAAAALAAAAAAXAEcAAAInjI+py+0Po5y02ouz" +
    "3rz7D4biSJbmiabqyrbuC8fyTNf2jef6zqcFADs=",
  "base64"
);

const WEBP_LOSSY_52x29 = Buffer.from(
  "UklGRkoAAABXRUJQVlA4ID4AAACQAwCdASo0AB0APm02mEkkIyKhJAgAgA2JZwB2APwA" +
    "AEnCt77QAP7kAX//5BcsLrka//+hJ+CT8En7gAAAAA==",
  "base64"
);

const WEBP_LOSSLESS_17x83 = Buffer.from(
  "UklGRiQAAABXRUJQVlA4TBcAAAAvEIAUAAdQqCIXpf8BICH8P69G9D+9AQA=",
  "base64"
);

const JPEG_EXIF_120x90 = Buffer.from(
  "/9j/4QJaRXhpZgAASUkqAAgAAAAHABIBAwABAAAAAQAAABoBBQABAAAAYgAAABsBBQAB" +
    "AAAAagAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAJiCAgCRAQAAcgAAAGmHBAABAAAA" +
    "BAIAAAAAAAA4YwAA6AMAADhjAADoAwAAeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eAAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAA" +
    "ADAxMDABoAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+IB8ElD" +
    "Q19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNz" +
    "cE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+" +
    "AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwA" +
    "AAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAU" +
    "Z1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRS" +
    "QwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAA" +
    "AAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1z" +
    "ZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAA" +
    "AABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2" +
    "xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcG" +
    "CAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko" +
    "/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgAWgB4AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAA" +
    "AAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAA" +
    "AAAGB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJACRaQAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAA//Z",
  "base64"
);

const WEBP_VP8X_96x31 = Buffer.from(
  "UklGRmwAAABXRUJQVlA4WAoAAAAQAAAAXwAAHgAAQUxQSBAAAAABB1DAiAgACeH/ejGi" +
    "/6kcVlA4IDYAAABQAwCdASpgAB8APm02mEkkIyKhIqgAgA2JaQAAE/GOKXzZYAD++iGX" +
    "zse4P+g+GifAJ+AAAAA=",
  "base64"
);

describe("imageDimensionsFromBuffer", () => {
  it.each([
    ["PNG", PNG_37x19, 37, 19],
    ["baseline JPEG", JPEG_64x41, 64, 41],
    ["JPEG behind an EXIF block", JPEG_EXIF_120x90, 120, 90],
    ["GIF89a", GIF_23x71, 23, 71],
    ["lossy WebP (VP8 )", WEBP_LOSSY_52x29, 52, 29],
    ["lossless WebP (VP8L)", WEBP_LOSSLESS_17x83, 17, 83],
    ["extended WebP (VP8X)", WEBP_VP8X_96x31, 96, 31],
  ])("reads %s", (_label, buffer, width, height) => {
    expect(imageDimensionsFromBuffer(buffer)).toEqual({ width, height });
  });

  it("returns null for a truncated header rather than throwing", () => {
    // Each format cut one byte short of the last byte its header needs, plus
    // the degenerate prefixes a partially-written upload leaves behind.
    const cases: Array<[Buffer, number]> = [
      [PNG_37x19, 23],
      [JPEG_64x41, 10],
      [GIF_23x71, 9],
      [WEBP_LOSSY_52x29, 29],
      [WEBP_LOSSLESS_17x83, 24],
      [WEBP_VP8X_96x31, 29],
    ];
    for (const [buffer, shortOf] of cases) {
      for (const keep of [0, 1, 2, 4, shortOf]) {
        expect(imageDimensionsFromBuffer(buffer.subarray(0, keep))).toBeNull();
      }
    }
  });

  it("returns null for a file that claims to be an image and is not", () => {
    // Right magic bytes, garbage after them — the shape a corrupted or
    // partially-written upload takes.
    const corruptPng = Buffer.concat([
      PNG_37x19.subarray(0, 8),
      Buffer.alloc(64, 0xab),
    ]);
    expect(imageDimensionsFromBuffer(corruptPng)).toBeNull();

    const corruptRiff = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(64, 0x00),
    ]);
    expect(imageDimensionsFromBuffer(corruptRiff)).toBeNull();
  });

  it("returns null for bytes of no image format at all", () => {
    expect(imageDimensionsFromBuffer(Buffer.alloc(0))).toBeNull();
    expect(imageDimensionsFromBuffer(Buffer.from("not an image"))).toBeNull();
    expect(
      imageDimensionsFromBuffer(Buffer.from("%PDF-1.7\n%abcd"))
    ).toBeNull();
  });

  it("rejects a header whose dimensions are impossible", () => {
    // A PNG IHDR claiming zero width: structurally valid, semantically not.
    const zeroWidth = Buffer.from(PNG_37x19);
    zeroWidth.writeUInt32BE(0, 16);
    expect(imageDimensionsFromBuffer(zeroWidth)).toBeNull();

    const absurd = Buffer.from(PNG_37x19);
    absurd.writeUInt32BE(4_000_000_000, 16);
    expect(imageDimensionsFromBuffer(absurd)).toBeNull();
  });
});

describe("probeImageFile", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dispatch-image-dims-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, buffer: Buffer): Promise<string> {
    const filePath = path.join(dir, name);
    await writeFile(filePath, buffer);
    return filePath;
  }

  it("reads dimensions off disk", async () => {
    await expect(
      probeImageFile(await write("a.png", PNG_37x19))
    ).resolves.toEqual({ width: 37, height: 19 });
    await expect(
      probeImageFile(await write("b.jpg", JPEG_EXIF_120x90))
    ).resolves.toEqual({ width: 120, height: 90 });
    await expect(
      probeImageFile(await write("c.webp", WEBP_LOSSLESS_17x83))
    ).resolves.toEqual({ width: 17, height: 83 });
  });

  it("skips files that are not images without reading them", async () => {
    await expect(
      probeImageFile(await write("notes.md", Buffer.from("# hi")))
    ).resolves.toBeNull();
    await expect(
      probeImageFile(await write("clip.mp4", Buffer.alloc(32)))
    ).resolves.toBeNull();
  });

  it("returns null for a malformed image rather than throwing", async () => {
    await expect(
      probeImageFile(await write("broken.png", Buffer.from("nope")))
    ).resolves.toBeNull();
  });

  it("returns null when the file is gone", async () => {
    await expect(
      probeImageFile(path.join(dir, "missing.png"))
    ).resolves.toBeNull();
  });
});
