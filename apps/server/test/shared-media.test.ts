import { describe, expect, it } from "vitest";

import {
  extensionForMime,
  isDocumentFile,
  isMediaFile,
  isTextFile,
  isValidMediaKey,
  mimeType,
  sanitizeUploadedFileName,
  toMediaKey,
} from "../src/shared/media.js";
import {
  MEDIA_UPLOAD_ACCEPT,
  TEXT_EXTENSIONS,
} from "../src/shared/media-file-types.js";

describe("sanitizeUploadedFileName", () => {
  it("passes through a clean filename unchanged", () => {
    expect(sanitizeUploadedFileName("screenshot.png")).toBe("screenshot.png");
  });

  it("lowercases the extension", () => {
    expect(sanitizeUploadedFileName("Photo.PNG")).toBe("Photo.png");
  });

  it("replaces special characters with hyphens", () => {
    expect(sanitizeUploadedFileName("my file [2024]!.txt")).toBe(
      "my-file-2024.txt"
    );
  });

  it("collapses multiple hyphens into one", () => {
    expect(sanitizeUploadedFileName("a---b---c.md")).toBe("a-b-c.md");
  });

  it("strips leading and trailing hyphens/dots from the basename", () => {
    expect(sanitizeUploadedFileName("--foo--.txt")).toBe("foo.txt");
    expect(sanitizeUploadedFileName("..bar...txt")).toBe("bar.txt");
  });

  it("normalizes Unicode combining characters (NFKD)", () => {
    expect(sanitizeUploadedFileName("café.txt")).toBe("cafe.txt");
    expect(sanitizeUploadedFileName("naïve.md")).toBe("naive.md");
  });

  it("falls back to 'file' when basename is entirely stripped", () => {
    expect(sanitizeUploadedFileName("!!!.png")).toBe("file.png");
    expect(sanitizeUploadedFileName("---...png")).toBe("file.png");
  });

  it("handles filenames with spaces converted to hyphens", () => {
    expect(sanitizeUploadedFileName("my cool file.jpg")).toBe(
      "my-cool-file.jpg"
    );
  });

  it("preserves parentheses and dots inside the basename", () => {
    expect(sanitizeUploadedFileName("image (1).png")).toBe("image-(1).png");
    expect(sanitizeUploadedFileName("notes.v2.txt")).toBe("notes.v2.txt");
  });
});

describe("isTextFile", () => {
  it("recognizes common text extensions", () => {
    expect(isTextFile("main.ts")).toBe(true);
    expect(isTextFile("app.tsx")).toBe(true);
    expect(isTextFile("readme.md")).toBe(true);
    expect(isTextFile("data.json")).toBe(true);
    expect(isTextFile("config.yaml")).toBe(true);
    expect(isTextFile("setup.py")).toBe(true);
    expect(isTextFile("server.go")).toBe(true);
    expect(isTextFile("lib.rs")).toBe(true);
  });

  it("is case-insensitive on extension", () => {
    expect(isTextFile("README.MD")).toBe(true);
    expect(isTextFile("data.JSON")).toBe(true);
  });

  it("rejects non-text extensions", () => {
    expect(isTextFile("photo.png")).toBe(false);
    expect(isTextFile("video.mp4")).toBe(false);
    expect(isTextFile("archive.zip")).toBe(false);
    expect(isTextFile("doc.pdf")).toBe(false);
  });

  it("recognizes extensions merged from the former web and server tables", () => {
    expect(isTextFile("config.env")).toBe(true);
    expect(isTextFile("script.mjs")).toBe(true);
    expect(isTextFile("script.cjs")).toBe(true);
    expect(isTextFile("setup.bash")).toBe(true);
    expect(isTextFile("rc.zsh")).toBe(true);
  });
});

describe("MEDIA_UPLOAD_ACCEPT", () => {
  it("lists every accepted text extension", () => {
    const entries = MEDIA_UPLOAD_ACCEPT.split(",");
    for (const ext of TEXT_EXTENSIONS) {
      expect(entries).toContain(ext);
    }
  });

  it("only lists extensions the upload endpoint accepts", () => {
    for (const ext of MEDIA_UPLOAD_ACCEPT.split(",")) {
      expect(isMediaFile(`file${ext}`)).toBe(true);
    }
  });
});

describe("isDocumentFile", () => {
  it("recognizes PDF files", () => {
    expect(isDocumentFile("report.pdf")).toBe(true);
    expect(isDocumentFile("REPORT.PDF")).toBe(true);
  });

  it("rejects non-document files", () => {
    expect(isDocumentFile("image.png")).toBe(false);
    expect(isDocumentFile("notes.txt")).toBe(false);
  });
});

describe("isMediaFile", () => {
  it("recognizes image files", () => {
    expect(isMediaFile("photo.png")).toBe(true);
    expect(isMediaFile("photo.jpg")).toBe(true);
    expect(isMediaFile("photo.jpeg")).toBe(true);
    expect(isMediaFile("photo.gif")).toBe(true);
    expect(isMediaFile("photo.webp")).toBe(true);
  });

  it("recognizes video files", () => {
    expect(isMediaFile("clip.mp4")).toBe(true);
  });

  it("recognizes text files as media", () => {
    expect(isMediaFile("code.ts")).toBe(true);
  });

  it("recognizes document files as media", () => {
    expect(isMediaFile("report.pdf")).toBe(true);
  });

  it("rejects unsupported extensions", () => {
    expect(isMediaFile("archive.zip")).toBe(false);
    expect(isMediaFile("binary.exe")).toBe(false);
  });
});

describe("mimeType", () => {
  it("returns correct MIME for images", () => {
    expect(mimeType("a.png")).toBe("image/png");
    expect(mimeType("a.jpg")).toBe("image/jpeg");
    expect(mimeType("a.jpeg")).toBe("image/jpeg");
    expect(mimeType("a.gif")).toBe("image/gif");
    expect(mimeType("a.webp")).toBe("image/webp");
  });

  it("returns correct MIME for video", () => {
    expect(mimeType("clip.mp4")).toBe("video/mp4");
  });

  it("returns correct MIME for structured text formats", () => {
    expect(mimeType("d.json")).toBe("application/json");
    expect(mimeType("d.xml")).toBe("application/xml");
    expect(mimeType("d.html")).toBe("text/html");
    expect(mimeType("d.css")).toBe("text/css");
    expect(mimeType("d.js")).toBe("text/javascript");
    expect(mimeType("d.mjs")).toBe("text/javascript");
    expect(mimeType("d.csv")).toBe("text/csv");
    expect(mimeType("d.md")).toBe("text/markdown");
    expect(mimeType("d.yaml")).toBe("text/yaml");
    expect(mimeType("d.yml")).toBe("text/yaml");
    expect(mimeType("d.pdf")).toBe("application/pdf");
  });

  it("returns text/plain for recognized text extensions without specific MIME", () => {
    expect(mimeType("main.go")).toBe("text/plain");
    expect(mimeType("lib.rs")).toBe("text/plain");
    expect(mimeType("app.py")).toBe("text/plain");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(mimeType("file.xyz")).toBe("application/octet-stream");
    expect(mimeType("archive.zip")).toBe("application/octet-stream");
  });
});

describe("toMediaKey", () => {
  it("joins name and updatedAt with a colon", () => {
    expect(
      toMediaKey({ name: "photo.png", updatedAt: "2026-01-01T00:00:00Z" })
    ).toBe("photo.png:2026-01-01T00:00:00Z");
  });
});

describe("isValidMediaKey", () => {
  it("accepts normal keys", () => {
    expect(isValidMediaKey("photo.png:2026-01-01T00:00:00Z")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidMediaKey("")).toBe(false);
  });

  it("rejects keys longer than 1024 characters", () => {
    expect(isValidMediaKey("a".repeat(1025))).toBe(false);
  });

  it("accepts keys of exactly 1024 characters", () => {
    expect(isValidMediaKey("a".repeat(1024))).toBe(true);
  });

  it("rejects keys containing control characters", () => {
    expect(isValidMediaKey("abc\x00def")).toBe(false);
    expect(isValidMediaKey("abc\ndef")).toBe(false);
    expect(isValidMediaKey("abc\tdef")).toBe(false);
  });
});

describe("extensionForMime", () => {
  it("returns .png for image/png", () => {
    expect(extensionForMime("image/png")).toBe(".png");
  });
  it("returns .jpg for image/jpeg", () => {
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
  });
  it("returns .gif for image/gif", () => {
    expect(extensionForMime("image/gif")).toBe(".gif");
  });
  it("returns .webp for image/webp", () => {
    expect(extensionForMime("image/webp")).toBe(".webp");
  });
  it("returns .png for unknown image types", () => {
    expect(extensionForMime("image/avif")).toBe(".png");
  });
  it("returns .mp4 for video/mp4", () => {
    expect(extensionForMime("video/mp4")).toBe(".mp4");
  });
  it("returns .pdf for application/pdf", () => {
    expect(extensionForMime("application/pdf")).toBe(".pdf");
  });
  it("returns .bin for non-media MIME types", () => {
    expect(extensionForMime("application/octet-stream")).toBe(".bin");
  });
});
