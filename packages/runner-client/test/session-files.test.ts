import { describe, expect, it, vi } from "vitest";
import {
  sessionFromWire,
  pathFromWire,
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import {
  localSessionFiles,
  withSessionFiles,
  withSessionFileBlob,
  type SessionFileBlob,
  type SessionFileTransfer,
} from "../src/session-files.js";

const session = sessionFromWire("agt_files");
const base = {
  call: vi.fn(),
  open: vi.fn(),
  describe: vi.fn(),
} as unknown as Runner;
function file(): SessionFileBlob {
  return {
    path: "/tmp/source",
    purpose: "reference",
    digest: vi.fn(async () => "digest"),
    source: vi.fn(),
  };
}
const input = { session, name: "ref.txt", size: 0, digest: "" };

describe("session file routing", () => {
  it("shares reference delivery across adapters, retries failed puts, and namespaces sessions", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValue({ path: pathFromWire("/stored") });
    const transfer: SessionFileTransfer = {
      copyReferences: true,
      scope: {},
      namespace: "runner",
      upload,
      download: vi.fn(),
    };
    const a = withSessionFiles(base, "agt_files", transfer);
    const b = withSessionFiles(base, "agt_files", transfer);
    await withSessionFileBlob(file(), async (blob) => {
      await expect(a.call("files.put", { ...input, blob })).rejects.toThrow(
        "lost"
      );
      const results = await Promise.all([
        a.call("files.put", { ...input, blob }),
        b.call("files.put", { ...input, blob }),
      ]);
      expect(results).toEqual([{ path: "/stored" }, { path: "/stored" }]);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(upload.mock.calls[1][0].name).toBe("reference-digest.txt");
      const other = withSessionFiles(base, "agt_other", transfer);
      await other.call("files.put", {
        ...input,
        session: sessionFromWire("agt_other"),
        blob,
      });
      expect(upload).toHaveBeenCalledTimes(3);
    });
  });

  it("hands Local paths over without reading or hashing them", async () => {
    const local = file();
    const call = vi.fn(async () => ({ path: pathFromWire(local.path) }));
    const sendBlob = vi.fn(async () => {});
    const fallback = { put: vi.fn(), get: vi.fn() };
    const runner = withSessionFiles(
      base,
      "agt_files",
      localSessionFiles({
        peer: { call: call as Runner["call"], sendBlob },
        bound: async () => true,
        fallback,
        mayWrite: vi.fn(),
      })
    );
    await withSessionFileBlob(local, async (blob) => {
      expect(await runner.call("files.put", { ...input, blob })).toEqual({
        path: local.path,
      });
    });
    expect(local.source).not.toHaveBeenCalled();
    expect(local.digest).not.toHaveBeenCalled();
    expect(fallback.put).not.toHaveBeenCalled();
    expect(sendBlob).toHaveBeenCalledWith(expect.any(String), {
      path: local.path,
      inPlace: { mustExist: false },
    });
  });

  it("does not retry an uncertain Local mutation or an aborted read", async () => {
    const fallback = { put: vi.fn(), get: vi.fn() };
    const abort = new AbortController();
    const error = new RunnerCallError({
      code: "unknown_outcome",
      message: "Lost",
    });
    const transfer = localSessionFiles({
      peer: {
        call: vi.fn(async () => {
          throw error;
        }) as Runner["call"],
        sendBlob: vi.fn(async () => {}),
        getFile: vi.fn(async (_input, signal) => {
          expect(signal).toBe(abort.signal);
          abort.abort();
          throw error;
        }),
      },
      bound: async () => true,
      fallback,
      mayWrite: vi.fn(),
    });
    await expect(
      transfer.upload({ ...input, blob: "token" }, file())
    ).rejects.toBe(error);
    await expect(
      transfer.download({ session, path: "/tmp/source" }, abort.signal)
    ).rejects.toBe(error);
    expect(fallback.put).not.toHaveBeenCalled();
    expect(fallback.get).not.toHaveBeenCalled();
  });
});
