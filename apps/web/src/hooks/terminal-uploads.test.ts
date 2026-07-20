import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadedMedia } from "@/lib/media-upload";

import { uploadTerminalFiles } from "./terminal-uploads";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/media-upload", () => ({
  isAcceptedUploadFile: vi.fn(),
  uploadAgentMedia: vi.fn(),
}));

const { toast } = await import("sonner");
const { isAcceptedUploadFile, uploadAgentMedia } =
  await import("@/lib/media-upload");

const mockAccepted = vi.mocked(isAcceptedUploadFile);
const mockUpload = vi.mocked(uploadAgentMedia);
const mockError = vi.mocked(toast.error);
const mockInfo = vi.mocked(toast.info);

function file(name: string): File {
  return new File(["x"], name);
}

/** Accept only names matching this suffix list; everything else is unsupported. */
function acceptSuffixes(...suffixes: string[]) {
  mockAccepted.mockImplementation((name: string) =>
    suffixes.some((suffix) => name.endsWith(suffix))
  );
}

const UPLOADED = {} as UploadedMedia;

/**
 * Wait for the fire-and-forget upload IIFE to finish. Clearing the uploading
 * flag happens in its `finally`, so this is the signal that no further work is
 * queued and the next test starts from a clean slate.
 */
function settle(setUploading: ReturnType<typeof vi.fn>) {
  return vi.waitFor(() =>
    expect(setUploading).toHaveBeenNthCalledWith(2, false)
  );
}

describe("uploadTerminalFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpload.mockResolvedValue(UPLOADED);
    // Default: everything is a supported type.
    mockAccepted.mockReturnValue(true);
  });

  // uploadTerminalFiles kicks off a fire-and-forget async IIFE, and some tests
  // assert only on its synchronous prelude. Restore mocks (notably the
  // console.warn spy) so nothing leaks into the next test or file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("guard clauses", () => {
    it("is a no-op for an empty file list", () => {
      const setUploading = vi.fn();

      uploadTerminalFiles("agt_1", [], setUploading);

      expect(setUploading).not.toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      expect(mockInfo).not.toHaveBeenCalled();
    });

    it("errors without uploading when no agent is connected", () => {
      const setUploading = vi.fn();

      uploadTerminalFiles(null, [file("a.png")], setUploading);

      expect(mockError).toHaveBeenCalledWith(
        "Connect to an agent before uploading files."
      );
      expect(mockUpload).not.toHaveBeenCalled();
      expect(setUploading).not.toHaveBeenCalled();
    });
  });

  describe("unsupported file types", () => {
    it("names the file when a single unsupported file is dropped", () => {
      mockAccepted.mockReturnValue(false);
      const setUploading = vi.fn();

      uploadTerminalFiles("agt_1", [file("notes.xyz")], setUploading);

      expect(mockError).toHaveBeenCalledWith(
        "Unsupported file type: notes.xyz"
      );
      expect(mockUpload).not.toHaveBeenCalled();
      expect(setUploading).not.toHaveBeenCalled();
    });

    it("uses the generic message when every file of several is unsupported", () => {
      mockAccepted.mockReturnValue(false);
      const setUploading = vi.fn();

      uploadTerminalFiles(
        "agt_1",
        [file("a.xyz"), file("b.xyz")],
        setUploading
      );

      expect(mockError).toHaveBeenCalledWith(
        "None of the dropped files are a supported type."
      );
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  describe("partial skips", () => {
    it("uploads the accepted files and reports the skipped ones", async () => {
      acceptSuffixes(".png");
      const setUploading = vi.fn();

      uploadTerminalFiles(
        "agt_1",
        [file("keep.png"), file("skip.xyz")],
        setUploading
      );

      expect(mockInfo).toHaveBeenCalledWith(
        "Skipped 1 unsupported file: skip.xyz"
      );
      await vi.waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
      expect(mockUpload).toHaveBeenCalledWith(
        "agt_1",
        expect.objectContaining({ name: "keep.png" }),
        { inject: true }
      );
      await settle(setUploading);
    });

    it("pluralizes and lists every skipped file name", async () => {
      acceptSuffixes(".png");
      const setUploading = vi.fn();

      uploadTerminalFiles(
        "agt_1",
        [file("keep.png"), file("a.xyz"), file("b.xyz")],
        setUploading
      );

      expect(mockInfo).toHaveBeenCalledWith(
        "Skipped 2 unsupported files: a.xyz, b.xyz"
      );
      await settle(setUploading);
    });

    it("does not report skips when every file is supported", async () => {
      const setUploading = vi.fn();

      uploadTerminalFiles("agt_1", [file("a.png")], setUploading);

      expect(mockInfo).not.toHaveBeenCalled();
      await settle(setUploading);
    });
  });

  describe("upload lifecycle", () => {
    it("toggles the uploading flag on, then off once uploads settle", async () => {
      const setUploading = vi.fn();

      uploadTerminalFiles("agt_1", [file("a.png")], setUploading);

      // Set synchronously so the UI reflects the upload immediately.
      expect(setUploading).toHaveBeenNthCalledWith(1, true);

      await vi.waitFor(() =>
        expect(setUploading).toHaveBeenNthCalledWith(2, false)
      );
      expect(setUploading).toHaveBeenCalledTimes(2);
    });

    it("uploads every accepted file with the inject flag", async () => {
      const setUploading = vi.fn();

      uploadTerminalFiles(
        "agt_1",
        [file("a.png"), file("b.png")],
        setUploading
      );

      // Wait for the flag reset, not just the last upload call — that is the
      // IIFE's final step, so the failure toast (if any) has already run.
      await vi.waitFor(() =>
        expect(setUploading).toHaveBeenNthCalledWith(2, false)
      );

      // Assert on file names: mapping the agent id would pass even if the same
      // file were uploaded twice and the second one never sent.
      expect(mockUpload.mock.calls.map((call) => call[1].name)).toEqual([
        "a.png",
        "b.png",
      ]);
      expect(mockUpload.mock.calls.every((call) => call[2]?.inject)).toBe(true);
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  describe("upload failures", () => {
    it("names the file when a single upload fails", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockUpload.mockRejectedValue(new Error("boom"));
      const setUploading = vi.fn();

      uploadTerminalFiles("agt_1", [file("a.png")], setUploading);

      await vi.waitFor(() =>
        expect(mockError).toHaveBeenCalledWith("Failed to upload a.png.")
      );
      expect(setUploading).toHaveBeenNthCalledWith(2, false);
    });

    it("counts the failures when several uploads fail", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockUpload.mockRejectedValue(new Error("boom"));

      uploadTerminalFiles("agt_1", [file("a.png"), file("b.png")], vi.fn());

      await vi.waitFor(() =>
        expect(mockError).toHaveBeenCalledWith("Failed to upload 2 files.")
      );
    });

    it("keeps uploading the remaining files after one fails", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockUpload
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined as never);

      uploadTerminalFiles("agt_1", [file("a.png"), file("b.png")], vi.fn());

      await vi.waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(mockError).toHaveBeenCalledWith("Failed to upload a.png.")
      );
    });

    it("still clears the uploading flag when uploads fail", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockUpload.mockRejectedValue(new Error("boom"));
      const setUploading = vi.fn();

      uploadTerminalFiles("agt_1", [file("a.png")], setUploading);

      await vi.waitFor(() =>
        expect(setUploading).toHaveBeenNthCalledWith(2, false)
      );
    });
  });
});
