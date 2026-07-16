import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerRequest, WorkerResponse } from "./types";

const CONNECTION_KEY = "dispatchConnection";

async function setupWorker(stored: Record<string, unknown> = {}): Promise<{
  send(request: WorkerRequest): Promise<WorkerResponse>;
  storage: Record<string, unknown>;
  storageSet: ReturnType<typeof vi.fn>;
}> {
  let messageListener:
    | ((
        request: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: WorkerResponse) => void
      ) => boolean)
    | undefined;
  const storage = { ...stored };
  const storageSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(storage, values);
  });

  vi.stubGlobal("chrome", {
    sidePanel: {
      setPanelBehavior: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: storageSet,
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
    runtime: {
      getPlatformInfo: vi.fn(async () => ({ os: "mac" })),
      onMessage: {
        addListener: vi.fn(
          (
            listener: (
              request: unknown,
              sender: chrome.runtime.MessageSender,
              sendResponse: (response: WorkerResponse) => void
            ) => boolean
          ) => {
            messageListener = listener;
          }
        ),
      },
    },
  });

  await import("./service-worker");

  return {
    storage,
    storageSet,
    send(request) {
      return new Promise((resolve, reject) => {
        if (!messageListener) {
          reject(
            new Error("Service worker message listener was not installed.")
          );
          return;
        }
        const remainsOpen = messageListener(request, {}, resolve);
        if (!remainsOpen) reject(new Error("Service worker rejected request."));
      });
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("service worker fetch security", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("rejects redirects for pairing and authenticated requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          pairingId: "pairing-1",
          pairingSecret: "secret",
          code: "ABCD-EFGH",
          verificationPath: "/settings/browser-extension",
          expiresAt: "2030-01-01T00:00:00.000Z",
        })
      )
      .mockResolvedValueOnce(jsonResponse({ agents: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const worker = await setupWorker({
      [CONNECTION_KEY]: {
        baseUrl: "https://dispatch.test",
        token: "browser-token",
      },
    });

    expect(
      await worker.send({
        type: "pairing:start",
        baseUrl: "https://dispatch.test",
      })
    ).toMatchObject({ ok: true });
    expect(await worker.send({ type: "agents:list" })).toEqual({
      ok: true,
      data: { agents: [] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ redirect: "error" }));
    }
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer browser-token" })
    );
  });

  it("reports a blocked redirect and does not persist an exchanged token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch redirected request"));
    vi.stubGlobal("fetch", fetchMock);
    const worker = await setupWorker();

    const response = await worker.send({
      type: "pairing:exchange",
      baseUrl: "https://dispatch.test",
      pairingId: "pairing-1",
      pairingSecret: "secret",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dispatch.test/api/v1/auth/browser-extension/pairings/pairing-1/exchange",
      expect.objectContaining({ redirect: "error" })
    );
    expect(response).toEqual({
      ok: false,
      error: "Failed to fetch redirected request",
    });
    expect(worker.storage[CONNECTION_KEY]).toBeUndefined();
    expect(worker.storageSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ [CONNECTION_KEY]: expect.anything() })
    );
  });

  it("forwards the client submission id in the protected request body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ submissionId: "server-id", status: "delivered" })
      );
    vi.stubGlobal("fetch", fetchMock);
    const worker = await setupWorker({
      [CONNECTION_KEY]: {
        baseUrl: "https://dispatch.test",
        token: "browser-token",
      },
    });

    const response = await worker.send({
      type: "submission:create",
      clientSubmissionId: "11111111-1111-4111-8111-111111111111",
      agentId: "agent-1",
      comment: "Change this button",
      selection: {
        page: {
          url: "https://example.test",
          title: "Example",
          viewport: { width: 1280, height: 720 },
          devicePixelRatio: 1,
        },
        element: {
          tagName: "button",
          selector: "#save",
          xpath: "//*[@id='save']",
          id: "save",
          classes: [],
          role: "button",
          accessibleName: "Save",
          text: "Save",
          outerHtml: '<button id="save">Save</button>',
          ancestors: [],
          nearbyElements: [],
          searchHints: [],
          rect: { x: 0, y: 0, width: 80, height: 32 },
        },
      },
    });

    expect(response).toMatchObject({ ok: true });
    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(requestBody.clientSubmissionId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ redirect: "error" })
    );
  });

  it("marks a server-confirmed submission failure as terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            submissionId: "server-id",
            status: "failed",
            error: "Prompt delivery failed.",
          },
          502
        )
      )
    );
    const worker = await setupWorker({
      [CONNECTION_KEY]: {
        baseUrl: "https://dispatch.test",
        token: "browser-token",
      },
    });

    const response = await worker.send({
      type: "submission:create",
      clientSubmissionId: "11111111-1111-4111-8111-111111111111",
      agentId: "agent-1",
      comment: "Change this button",
      selection: {
        page: {
          url: "https://example.test",
          title: "Example",
          viewport: { width: 1280, height: 720 },
          devicePixelRatio: 1,
        },
        element: {
          tagName: "button",
          selector: "#save",
          xpath: "//*[@id='save']",
          id: "save",
          classes: [],
          role: "button",
          accessibleName: "Save",
          text: "Save",
          outerHtml: '<button id="save">Save</button>',
          ancestors: [],
          nearbyElements: [],
          searchHints: [],
          rect: { x: 0, y: 0, width: 80, height: 32 },
        },
      },
    });

    expect(response).toEqual({
      ok: false,
      error: "Prompt delivery failed.",
      submissionTerminalFailure: true,
    });
  });
});
