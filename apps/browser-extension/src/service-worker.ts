import {
  isWorkerRequest,
  type BrowserSelection,
  type ConnectionStatus,
  type DispatchAgent,
  type WorkerRequest,
  type WorkerResponse,
} from "./types";
import { normalizeDispatchBaseUrl } from "./lib/dispatch-url";
import { buildDeviceName } from "./lib/device-name";

const CONNECTION_KEY = "dispatchConnection";
const DEVICE_NAME_KEY = "dispatchDeviceName";
const REQUEST_TIMEOUT_MS = 15_000;

interface StoredConnection {
  baseUrl: string;
  token: string;
}

interface PairingStartResponse {
  pairingId: string;
  pairingSecret: string;
  code: string;
  verificationPath: string;
  expiresAt: string;
}

interface PairingExchangeResponse {
  status: "pending" | "approved";
  token?: string;
}

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    // Older managed Chrome builds can reject this until the extension is reloaded.
  });

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly submissionTerminalFailure = false
  ) {
    super(message);
  }
}

async function getConnection(): Promise<StoredConnection | null> {
  const stored = await chrome.storage.local.get(CONNECTION_KEY);
  return (stored[CONNECTION_KEY] as StoredConnection | undefined) ?? null;
}

async function getDeviceName(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_NAME_KEY);
  const existing = stored[DEVICE_NAME_KEY];
  if (typeof existing === "string" && existing.length > 0) return existing;

  const platform = await chrome.runtime.getPlatformInfo();
  const name = buildDeviceName(
    platform.os,
    crypto.randomUUID().replaceAll("-", "").slice(0, 4)
  );
  await chrome.storage.local.set({ [DEVICE_NAME_KEY]: name });
  return name;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  expectedStatuses: number[] = [200]
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("Dispatch did not respond in time.");
    }
    throw error;
  }
  const body = (await response.json().catch(() => null)) as
    | (T & {
        message?: string;
        error?: string;
        status?: unknown;
        submissionId?: unknown;
      })
    | null;
  if (!expectedStatuses.includes(response.status)) {
    const message =
      body?.message ?? body?.error ?? `Dispatch returned ${response.status}.`;
    throw new HttpStatusError(
      message,
      response.status,
      body?.status === "failed" && typeof body.submissionId === "string"
    );
  }
  if (!body) throw new Error("Dispatch returned an empty response.");
  return body;
}

async function authenticatedFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const connection = await getConnection();
  if (!connection) throw new Error("Connect this extension to Dispatch first.");

  try {
    return await fetchJson<T>(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 401) {
      await chrome.storage.local.remove(CONNECTION_KEY);
    }
    throw error;
  }
}

async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  switch (request.type) {
    case "connection:status": {
      const connection = await getConnection();
      const status: ConnectionStatus = connection
        ? { connected: true, baseUrl: connection.baseUrl }
        : { connected: false };
      return { ok: true, data: status };
    }
    case "connection:disconnect": {
      let revokedRemotely = true;
      try {
        await authenticatedFetch<{ ok: boolean }>(
          "/api/v1/browser-extension/token",
          { method: "DELETE" }
        );
      } catch {
        revokedRemotely = false;
      } finally {
        await chrome.storage.local.remove(CONNECTION_KEY);
      }
      return { ok: true, data: { revokedRemotely } };
    }
    case "pairing:start": {
      const baseUrl = normalizeDispatchBaseUrl(request.baseUrl);
      const deviceName = await getDeviceName();
      let pairing: PairingStartResponse;
      try {
        pairing = await fetchJson<PairingStartResponse>(
          `${baseUrl}/api/v1/auth/browser-extension/pairings`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceName }),
          },
          [200, 201]
        );
      } catch (error) {
        if (error instanceof HttpStatusError && error.status === 404) {
          throw new Error(
            "This Dispatch instance does not support browser feedback pairing. Connect to the Dispatch instance managing your agent, not the web app you want to inspect."
          );
        }
        throw error;
      }
      return { ok: true, data: { ...pairing, baseUrl } };
    }
    case "pairing:exchange": {
      const baseUrl = normalizeDispatchBaseUrl(request.baseUrl);
      const result = await fetchJson<PairingExchangeResponse>(
        `${baseUrl}/api/v1/auth/browser-extension/pairings/${encodeURIComponent(request.pairingId)}/exchange`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingSecret: request.pairingSecret }),
        }
      );
      if (result.status === "approved" && result.token) {
        await chrome.storage.local.set({
          [CONNECTION_KEY]: {
            baseUrl,
            token: result.token,
          } satisfies StoredConnection,
        });
      }
      return { ok: true, data: result };
    }
    case "agents:list": {
      const result = await authenticatedFetch<{ agents: DispatchAgent[] }>(
        "/api/v1/browser-extension/agents"
      );
      return { ok: true, data: result };
    }
    case "submission:create": {
      const body: {
        clientSubmissionId: string;
        agentId: string;
        comment: string;
        page: BrowserSelection["page"];
        element: BrowserSelection["element"];
      } = {
        clientSubmissionId: request.clientSubmissionId,
        agentId: request.agentId,
        comment: request.comment,
        page: request.selection.page,
        element: request.selection.element,
      };
      const result = await authenticatedFetch<unknown>(
        "/api/v1/browser-extension/submissions",
        { method: "POST", body: JSON.stringify(body) }
      );
      return { ok: true, data: result };
    }
  }
}

chrome.runtime.onMessage.addListener(
  (request: unknown, _sender, sendResponse) => {
    if (!isWorkerRequest(request)) return false;

    void handleRequest(request)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          submissionTerminalFailure:
            error instanceof HttpStatusError
              ? error.submissionTerminalFailure
              : undefined,
          error:
            error instanceof Error
              ? error.message
              : "Unexpected extension error.",
        } satisfies WorkerResponse);
      });
    return true;
  }
);
