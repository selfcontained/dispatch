import { afterEach, describe, expect, it, vi } from "vitest";

import { isMediaFile } from "../../../server/src/shared/media-file-types";
import {
  STARTUP_FILE_ACCEPT,
  isAcceptedUploadFile,
  uploadAgentMedia,
} from "./media-upload";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

afterEach(() => {
  // restoreAllMocks alone stops resetting module-factory vi.fn() mocks in
  // vitest 3 — reset explicitly so call history and implementations never
  // leak across tests.
  apiMock.mockReset();
});

describe("isAcceptedUploadFile", () => {
  it("accepts every extension the upload endpoint accepts", () => {
    for (const ext of STARTUP_FILE_ACCEPT.split(",")) {
      expect(isAcceptedUploadFile(`report${ext}`), ext).toBe(true);
    }
  });

  it("agrees with the server's isMediaFile validation", () => {
    const names = [
      "shot.png",
      "clip.mp4",
      "notes.md",
      "doc.pdf",
      "binary.exe",
      "archive.tar.gz",
      "no-extension",
    ];
    for (const name of names) {
      expect(isAcceptedUploadFile(name), name).toBe(isMediaFile(name));
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(isAcceptedUploadFile("SHOT.PNG")).toBe(true);
    expect(isAcceptedUploadFile("Notes.Md")).toBe(true);
  });

  it("uses only the last extension of a multi-dot name", () => {
    expect(isAcceptedUploadFile("notes.backup.md")).toBe(true);
  });

  it("rejects names without an extension", () => {
    expect(isAcceptedUploadFile("Makefile")).toBe(false);
    expect(isAcceptedUploadFile("")).toBe(false);
  });

  it("rejects a bare trailing dot", () => {
    expect(isAcceptedUploadFile("file.")).toBe(false);
  });

  it("rejects unsupported extensions", () => {
    expect(isAcceptedUploadFile("malware.exe")).toBe(false);
    expect(isAcceptedUploadFile("data.parquet")).toBe(false);
  });
});

describe("uploadAgentMedia", () => {
  const media = {
    id: 7,
    fileName: "shot.png",
    source: "user",
    sizeBytes: 3,
    createdAt: "2026-07-29T00:00:00.000Z",
    url: "/api/v1/agents/agt_1/media/7",
    path: "/srv/media/shot.png",
    delivery: "none" as const,
  };

  it("POSTs the file to the agent's media endpoint and returns the metadata", async () => {
    apiMock.mockResolvedValueOnce({ ok: true, media });
    const file = new File(["abc"], "shot.png", { type: "image/png" });

    const result = await uploadAgentMedia("agt_1", file);

    expect(result).toEqual(media);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [url, init] = apiMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/agents/agt_1/media");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const sent = form.get("file") as File;
    expect(sent.name).toBe("shot.png");
    expect(await sent.text()).toBe("abc");
  });

  it("defaults the source to 'user' and omits inject", async () => {
    apiMock.mockResolvedValueOnce({ ok: true, media });

    await uploadAgentMedia("agt_1", new File(["x"], "shot.png"));

    const form = (apiMock.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get("source")).toBe("user");
    expect(form.get("inject")).toBeNull();
  });

  it("sends the caller's source tag", async () => {
    apiMock.mockResolvedValueOnce({ ok: true, media });

    await uploadAgentMedia("agt_1", new File(["x"], "shot.png"), {
      source: "screenshot",
    });

    const form = (apiMock.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get("source")).toBe("screenshot");
  });

  it("flags inject only when requested", async () => {
    apiMock.mockResolvedValueOnce({ ok: true, media });
    apiMock.mockResolvedValueOnce({ ok: true, media });

    await uploadAgentMedia("agt_1", new File(["x"], "shot.png"), {
      inject: true,
    });
    await uploadAgentMedia("agt_1", new File(["x"], "shot.png"), {
      inject: false,
    });

    const first = (apiMock.mock.calls[0]![1] as RequestInit).body as FormData;
    const second = (apiMock.mock.calls[1]![1] as RequestInit).body as FormData;
    expect(first.get("inject")).toBe("true");
    expect(second.get("inject")).toBeNull();
  });

  it("propagates API failures", async () => {
    apiMock.mockRejectedValueOnce(new Error("upload rejected"));

    await expect(
      uploadAgentMedia("agt_1", new File(["x"], "shot.png"))
    ).rejects.toThrow("upload rejected");
  });
});
