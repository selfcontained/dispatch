import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./types";

let stored: Record<string, unknown>;
let dispatch: (request: WorkerRequest) => Promise<WorkerResponse>;
const receipt = {
  submissionId: "receipt",
  status: "pending",
  blockId: "block",
  streamId: "agent",
};
const request: WorkerRequest = {
  type: "submission:create",
  clientSubmissionId: "client",
  agentId: "agent",
  comment: "Fix spacing",
  selection: {
    page: {
      url: "https://example.com",
      title: "Example",
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 1,
    },
    element: {} as never,
  },
};

beforeEach(async () => {
  vi.resetModules();
  stored = {
    dispatchConnection: {
      baseUrl: "https://dispatch.example",
      token: "test-token",
    },
  };
  vi.stubGlobal("chrome", {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (values: object) => {
          Object.assign(stored, values);
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) delete stored[key];
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (
          listener: (
            request: WorkerRequest,
            sender: object,
            response: (value: WorkerResponse) => void
          ) => boolean
        ) => {
          dispatch = (request) =>
            new Promise((resolve) => listener(request, {}, resolve));
        },
      },
    },
  });
  await import("./service-worker");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser feedback delivery", () => {
  it("accepts queued responses and saves the receipt lookup before sending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        expect(stored.dispatchLastSubmission).toEqual({
          baseUrl: "https://dispatch.example",
          clientId: "client",
        });
        return Response.json(receipt, { status: 202 });
      })
    );
    expect(await dispatch(request)).toEqual({ ok: true, data: receipt });
  });
  it("reconciles a lost response using the saved client id, without resubmitting", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(
        Response.json({ ...receipt, status: "delivered" })
      );
    vi.stubGlobal("fetch", fetch);
    expect((await dispatch(request)).ok).toBe(false);
    expect(await dispatch({ type: "submission:latest" })).toMatchObject({
      ok: true,
      data: { status: "delivered" },
    });
    expect(fetch.mock.calls[1][0]).toBe(
      "https://dispatch.example/api/v1/browser-extension/submissions/client"
    );
    expect(fetch.mock.calls[1][1].method).toBeUndefined();
  });
  it("returns failed delivery as status data so the panel can offer the stream's retry", async () => {
    stored.dispatchLastSubmission = {
      baseUrl: "https://dispatch.example",
      clientId: "client",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...receipt, status: "failed" }))
    );
    expect(await dispatch({ type: "submission:latest" })).toMatchObject({
      ok: true,
      data: { status: "failed", blockId: "block" },
    });
  });
  it("does not look up a receipt belonging to another Dispatch instance", async () => {
    stored.dispatchLastSubmission = {
      baseUrl: "https://other.example",
      clientId: "client",
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await dispatch({ type: "submission:latest" })).toEqual({
      ok: true,
      data: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
