import { describe, expect, it } from "vitest";

import { claimedMimeType, detectFileType } from "../src/files/file-type.js";
import {
  BINARY_BYTES,
  JPEG_BYTES,
  MP4_BYTES,
  PDF_BYTES,
  PNG_BYTES,
} from "./helpers/file-bytes.js";

const typeOf = (bytes: Buffer, name: string) => detectFileType(bytes, name);

describe("detectFileType", () => {
  it("types binary files by their signature", () => {
    expect(typeOf(PNG_BYTES, "a.png")).toMatchObject({
      ok: true,
      mimeType: "image/png",
    });
    expect(typeOf(JPEG_BYTES, "a.jpeg")).toMatchObject({
      ok: true,
      mimeType: "image/jpeg",
    });
    expect(typeOf(Buffer.from("GIF89a..."), "a.gif")).toMatchObject({
      ok: true,
      mimeType: "image/gif",
    });
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBPVP8 "),
    ]);
    expect(typeOf(webp, "a.webp")).toMatchObject({
      ok: true,
      mimeType: "image/webp",
    });
    expect(typeOf(PDF_BYTES, "a.pdf")).toMatchObject({
      ok: true,
      mimeType: "application/pdf",
    });
    expect(typeOf(MP4_BYTES, "a.mp4")).toMatchObject({
      ok: true,
      mimeType: "video/mp4",
    });
  });

  it("returns the media readers switch on alongside the type", () => {
    expect(typeOf(PNG_BYTES, "a.png")).toMatchObject({ media: "image" });
    expect(typeOf(PDF_BYTES, "a.pdf")).toMatchObject({ media: "pdf" });
    expect(typeOf(Buffer.from("# hi"), "a.md")).toMatchObject({
      media: "text",
    });
  });

  it("goes by the bytes when the name says nothing about them", () => {
    // A pasted image with no extension, or one named for something else.
    expect(typeOf(PNG_BYTES, "clipboard-image")).toMatchObject({
      ok: true,
      mimeType: "image/png",
    });
    expect(typeOf(PNG_BYTES, "notes.txt")).toMatchObject({
      ok: true,
      mimeType: "image/png",
    });
  });

  it("says in plain words why a file was refused", () => {
    expect(typeOf(JPEG_BYTES, "shot.png")).toEqual({
      ok: false,
      error: "shot.png isn't a PNG image, it's actually a JPEG image.",
    });
    expect(typeOf(Buffer.from("hello"), "clip.mp4")).toEqual({
      ok: false,
      error: "clip.mp4 isn't an MP4 video: its contents don't match its name.",
    });
  });

  it("refuses a name that promises a binary type the bytes are not", () => {
    expect(typeOf(JPEG_BYTES, "shot.png")).toMatchObject({ ok: false });
    expect(typeOf(Buffer.from("hello"), "shot.png")).toMatchObject({
      ok: false,
    });
    expect(typeOf(PNG_BYTES, "report.pdf")).toMatchObject({ ok: false });
  });

  it("refuses an ISO media file that is not MP4, such as HEIC", () => {
    const heic = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(typeOf(heic, "photo.heic")).toMatchObject({ ok: false });
  });

  it("types text from its bytes and takes only the subtype from the name", () => {
    expect(typeOf(Buffer.from("# Notes"), "notes.md")).toMatchObject({
      ok: true,
      mimeType: "text/markdown",
    });
    expect(typeOf(Buffer.from('{"a":1}'), "data.json")).toMatchObject({
      ok: true,
      mimeType: "application/json",
    });
    expect(typeOf(Buffer.from("const a = 1;"), "a.ts")).toMatchObject({
      ok: true,
      mimeType: "text/plain",
    });
    expect(typeOf(Buffer.from("déjà vu"), "Makefile")).toMatchObject({
      ok: true,
      mimeType: "text/plain",
    });
    expect(typeOf(Buffer.alloc(0), "empty.txt")).toMatchObject({
      ok: true,
      mimeType: "text/plain",
    });
  });

  it("refuses bytes that are neither a known binary type nor text", () => {
    expect(typeOf(BINARY_BYTES, "blob.bin")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unsupported file type"),
    });
    // Not valid UTF-8, even with no NUL byte.
    expect(typeOf(Buffer.from([0xc3, 0x28]), "bad.txt")).toMatchObject({
      ok: false,
    });
  });
});

describe("claimedMimeType", () => {
  it("returns correct MIME for images", () => {
    expect(claimedMimeType("a.png")).toBe("image/png");
    expect(claimedMimeType("a.jpg")).toBe("image/jpeg");
    expect(claimedMimeType("a.jpeg")).toBe("image/jpeg");
    expect(claimedMimeType("a.gif")).toBe("image/gif");
    expect(claimedMimeType("a.webp")).toBe("image/webp");
  });

  it("returns correct MIME for video", () => {
    expect(claimedMimeType("clip.mp4")).toBe("video/mp4");
  });

  it("returns correct MIME for structured text formats", () => {
    expect(claimedMimeType("d.json")).toBe("application/json");
    expect(claimedMimeType("d.xml")).toBe("application/xml");
    expect(claimedMimeType("d.html")).toBe("text/html");
    expect(claimedMimeType("d.css")).toBe("text/css");
    expect(claimedMimeType("d.js")).toBe("text/javascript");
    expect(claimedMimeType("d.mjs")).toBe("text/javascript");
    expect(claimedMimeType("d.csv")).toBe("text/csv");
    expect(claimedMimeType("d.md")).toBe("text/markdown");
    expect(claimedMimeType("d.yaml")).toBe("text/yaml");
    expect(claimedMimeType("d.yml")).toBe("text/yaml");
    expect(claimedMimeType("d.pdf")).toBe("application/pdf");
  });

  it("returns text/plain for recognized text extensions without specific MIME", () => {
    expect(claimedMimeType("main.go")).toBe("text/plain");
    expect(claimedMimeType("lib.rs")).toBe("text/plain");
    expect(claimedMimeType("app.py")).toBe("text/plain");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(claimedMimeType("file.xyz")).toBe("application/octet-stream");
    expect(claimedMimeType("archive.zip")).toBe("application/octet-stream");
  });
});
