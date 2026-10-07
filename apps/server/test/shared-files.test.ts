import os from "node:os";
import path from "node:path";

import { resolveConfiguredPath } from "../src/shared/lib/resolve-tilde.js";
import { describe, expect, it } from "vitest";

import {
  extensionForMime,
  isDocumentFile,
  isTextFile,
  isValidFileKey,
  resolveFilesDir,
  sanitizeUploadedFileName,
  toFileKey,
} from "../src/shared/files.js";
import { claimedMimeType } from "../src/files/file-type.js";
import {
  FILE_UPLOAD_ACCEPT,
  TEXT_EXTENSIONS,
} from "../src/shared/file-types.js";

describe("file storage paths", () => {
  it("expands a home-relative storage path to an absolute path", () => {
    expect(resolveConfiguredPath("~/.dispatch/files")).toBe(
      path.join(os.homedir(), ".dispatch", "files")
    );
  });

  it("returns an absolute files directory when the configured root uses ~", () => {
    expect(resolveFilesDir("agt_test", null, "~/.dispatch/files")).toBe(
      path.join(os.homedir(), ".dispatch", "files", "agt_test")
    );
  });
});

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

describe("FILE_UPLOAD_ACCEPT", () => {
  it("lists every accepted text extension", () => {
    const entries = FILE_UPLOAD_ACCEPT.split(",");
    for (const ext of TEXT_EXTENSIONS) {
      expect(entries).toContain(ext);
    }
  });

  it("only offers extensions the upload path has a type for", () => {
    for (const ext of FILE_UPLOAD_ACCEPT.split(",")) {
      expect(claimedMimeType(`file${ext}`), ext).not.toBe(
        "application/octet-stream"
      );
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

describe("toFileKey", () => {
  it("joins name and updatedAt with a colon", () => {
    expect(
      toFileKey({ name: "photo.png", updatedAt: "2026-01-01T00:00:00Z" })
    ).toBe("photo.png:2026-01-01T00:00:00Z");
  });
});

describe("isValidFileKey", () => {
  it("accepts normal keys", () => {
    expect(isValidFileKey("photo.png:2026-01-01T00:00:00Z")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidFileKey("")).toBe(false);
  });

  it("rejects keys longer than 1024 characters", () => {
    expect(isValidFileKey("a".repeat(1025))).toBe(false);
  });

  it("accepts keys of exactly 1024 characters", () => {
    expect(isValidFileKey("a".repeat(1024))).toBe(true);
  });

  it("rejects keys containing control characters", () => {
    expect(isValidFileKey("abc\x00def")).toBe(false);
    expect(isValidFileKey("abc\ndef")).toBe(false);
    expect(isValidFileKey("abc\tdef")).toBe(false);
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
  it("returns .bin for unknown MIME types", () => {
    expect(extensionForMime("application/octet-stream")).toBe(".bin");
  });
});
