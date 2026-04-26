import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClipboardSuggestionFromFile,
  createClipboardSuggestionFromText,
  describeClipboardFileType,
  extensionForMimeType,
  getClipboardSuggestion,
  isClipboardAttachmentType,
  isLikelyUrl,
} from "./create-agent-dialog-clipboard";

describe("create-agent-dialog clipboard helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isLikelyUrl", () => {
    it("accepts http and https urls", () => {
      expect(isLikelyUrl("https://example.com")).toBe(true);
      expect(isLikelyUrl(" http://example.com/path ")).toBe(true);
    });

    it("rejects non-http protocols and whitespace text", () => {
      expect(isLikelyUrl("ftp://example.com")).toBe(false);
      expect(isLikelyUrl("not a url")).toBe(false);
      expect(isLikelyUrl("")).toBe(false);
    });
  });

  describe("describeClipboardFileType", () => {
    it("classifies common supported file types", () => {
      expect(describeClipboardFileType("image/png")).toEqual({
        noun: "image",
        actionLabel: "Add clipboard image",
      });
      expect(describeClipboardFileType("application/pdf")).toEqual({
        noun: "PDF",
        actionLabel: "Add clipboard PDF",
      });
      expect(describeClipboardFileType("audio/mpeg")).toEqual({
        noun: "audio file",
        actionLabel: "Add clipboard audio",
      });
    });

    it("falls back to generic file labels", () => {
      expect(describeClipboardFileType("application/zip")).toEqual({
        noun: "file",
        actionLabel: "Add clipboard file",
      });
    });
  });

  describe("isClipboardAttachmentType", () => {
    it("accepts binary attachment types but not rich text", () => {
      expect(isClipboardAttachmentType("image/png")).toBe(true);
      expect(isClipboardAttachmentType("video/mp4")).toBe(true);
      expect(isClipboardAttachmentType("application/pdf")).toBe(true);
      expect(isClipboardAttachmentType("text/html")).toBe(false);
      expect(isClipboardAttachmentType("text/plain")).toBe(false);
    });
  });

  describe("extensionForMimeType", () => {
    it("maps known mime types and falls back to subtype/bin", () => {
      expect(extensionForMimeType("image/jpeg")).toBe("jpg");
      expect(extensionForMimeType("text/markdown")).toBe("md");
      expect(extensionForMimeType("application/x-custom")).toBe("x-custom");
      expect(extensionForMimeType("")).toBe("bin");
    });
  });

  describe("createClipboardSuggestionFromText", () => {
    it("returns url suggestions for copied links", () => {
      expect(createClipboardSuggestionFromText("https://example.com")).toEqual({
        kind: "url",
        title: "Copied link ready",
        description: "Add copied link?",
        actionLabel: "Add copied link",
        url: "https://example.com",
      });
    });

    it("returns prompt suggestions for plain text", () => {
      expect(createClipboardSuggestionFromText("  hello world  ")).toEqual({
        kind: "text",
        title: "Copied prompt ready",
        description: "Use copied text as instructions?",
        actionLabel: "Use copied text",
        text: "hello world",
      });
    });

    it("returns null for empty text", () => {
      expect(createClipboardSuggestionFromText("   ")).toBeNull();
    });
  });

  describe("createClipboardSuggestionFromFile", () => {
    it("returns image and file suggestions with the right labels", () => {
      const image = new File(["img"], "photo.png", { type: "image/png" });
      const pdf = new File(["pdf"], "doc.pdf", { type: "application/pdf" });

      expect(createClipboardSuggestionFromFile(image)).toMatchObject({
        kind: "image",
        title: "Clipboard image ready",
        description: "Add copied image?",
        actionLabel: "Add clipboard image",
      });
      expect(createClipboardSuggestionFromFile(pdf)).toMatchObject({
        kind: "file",
        title: "Clipboard file ready",
        description: "Add copied PDF?",
        actionLabel: "Add clipboard PDF",
      });
    });
  });

  describe("getClipboardSuggestion", () => {
    it("returns unsupported when clipboard api is absent", async () => {
      vi.stubGlobal("navigator", {});

      await expect(getClipboardSuggestion()).resolves.toEqual({
        suggestion: null,
        canRead: false,
        status: "unsupported",
      });
    });

    it("prefers attachment reads for real files", async () => {
      const blob = new Blob(["pdf"], { type: "application/pdf" });
      vi.stubGlobal("navigator", {
        clipboard: {
          read: vi.fn().mockResolvedValue([
            {
              types: ["application/pdf"],
              getType: vi.fn().mockResolvedValue(blob),
            },
          ]),
          readText: vi.fn().mockResolvedValue("https://ignored.example.com"),
        },
      });

      const result = await getClipboardSuggestion();
      expect(result.status).toBe("found");
      expect(result.canRead).toBe(true);
      expect(result.suggestion).toMatchObject({
        kind: "file",
        description: "Add copied PDF?",
      });
    });

    it("falls back from rich text clipboard items to readText url detection", async () => {
      vi.stubGlobal("navigator", {
        clipboard: {
          read: vi.fn().mockResolvedValue([
            {
              types: ["text/html"],
              getType: vi.fn(),
            },
          ]),
          readText: vi.fn().mockResolvedValue("https://example.com"),
        },
      });

      await expect(getClipboardSuggestion()).resolves.toMatchObject({
        canRead: true,
        status: "found",
        suggestion: {
          kind: "url",
          description: "Add copied link?",
        },
      });
    });

    it("returns blocked when clipboard access is denied", async () => {
      vi.stubGlobal("navigator", {
        clipboard: {
          read: vi.fn().mockRejectedValue({ name: "NotAllowedError" }),
          readText: vi.fn(),
        },
      });

      await expect(getClipboardSuggestion()).resolves.toEqual({
        suggestion: null,
        canRead: true,
        status: "blocked",
      });
    });

    it("returns empty when readText resolves to empty text", async () => {
      vi.stubGlobal("navigator", {
        clipboard: {
          readText: vi.fn().mockResolvedValue("   "),
        },
      });

      await expect(getClipboardSuggestion()).resolves.toEqual({
        suggestion: null,
        canRead: true,
        status: "empty",
      });
    });
  });
});
