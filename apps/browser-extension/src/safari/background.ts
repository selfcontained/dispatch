import {
  isSafariRequest,
  isWorkerRequest,
  type DispatchAgent,
  type OverlayInitData,
  type SafariRequest,
  type WorkerResponse,
} from "../types";
import {
  getConnection,
  handleWorkerRequest,
  toErrorResponse,
  type PairingExchangeResponse,
  type PairingStartResponse,
} from "../lib/worker-core";
import { api } from "../lib/extension-api";
import { buildSafariDeviceName } from "../lib/device-name";
import {
  loadRememberedAgentId,
  rememberAgentSelection,
} from "../lib/agent-memory";
import { PairingSession, type PendingPairing } from "./pairing-session";
import { ArmError, OverlaySession } from "./overlay-session";

function buildName(os: string, suffix: string): string {
  // Worker contexts lack maxTouchPoints; default to touch-capable so a
  // desktop-mode iPad UA ("Macintosh" + os "ios") still labels as iPadOS.
  const maxTouchPoints =
    (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ?? 2;
  return buildSafariDeviceName(os, navigator.userAgent, maxTouchPoints, suffix);
}

const storage = {
  get: (key: string) => api.storage.local.get(key),
  set: (items: Record<string, unknown>) => api.storage.local.set(items),
  remove: (key: string) => api.storage.local.remove(key),
};

const pairingSession = new PairingSession({
  storage,
  exchange: async (pending: PendingPairing) => {
    const response = await handleWorkerRequest(
      {
        type: "pairing:exchange",
        baseUrl: pending.baseUrl,
        pairingId: pending.pairingId,
        pairingSecret: pending.pairingSecret,
      },
      buildName
    );
    return response.data as PairingExchangeResponse;
  },
  disconnect: async () => {
    await handleWorkerRequest({ type: "connection:disconnect" }, buildName);
  },
});

const overlaySession = new OverlaySession();

function verificationUrl(
  pairing: PairingStartResponse,
  baseUrl: string
): string {
  const url = new URL(pairing.verificationPath, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error("Dispatch returned an unexpected verification address.");
  }
  return url.href;
}

async function handleSafariRequest(
  request: SafariRequest,
  sender: chrome.runtime.MessageSender
): Promise<WorkerResponse> {
  switch (request.type) {
    case "pairing:begin": {
      const started = await handleWorkerRequest(
        { type: "pairing:start", baseUrl: request.baseUrl },
        buildName
      );
      const pairing = started.data as PairingStartResponse & {
        baseUrl: string;
      };
      const pending: PendingPairing = {
        baseUrl: pairing.baseUrl,
        pairingId: pairing.pairingId,
        pairingSecret: pairing.pairingSecret,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
      };
      await pairingSession.begin(pending);
      return {
        ok: true,
        data: {
          code: pairing.code,
          expiresAt: pairing.expiresAt,
          verificationUrl: verificationUrl(pairing, pairing.baseUrl),
        },
      };
    }
    case "pairing:status": {
      return { ok: true, data: await pairingSession.status() };
    }
    case "pairing:cancel": {
      await pairingSession.cancel();
      return { ok: true, data: {} };
    }
    case "picker:arm": {
      await overlaySession.arm();
      return { ok: true, data: {} };
    }
    case "picker:disarm": {
      await overlaySession.disarm({ cleanup: true });
      return { ok: true, data: {} };
    }
    case "overlay:init": {
      const connection = await getConnection();
      if (!connection) {
        const data: OverlayInitData = {
          connected: false,
          agents: [],
          selectedAgentId: null,
        };
        return { ok: true, data };
      }
      const listed = await handleWorkerRequest(
        { type: "agents:list" },
        buildName
      );
      const agents = (listed.data as { agents: DispatchAgent[] }).agents;
      const remembered = await loadRememberedAgentId(
        storage,
        connection.baseUrl,
        request.origin
      );
      const data: OverlayInitData = {
        connected: true,
        baseUrl: connection.baseUrl,
        agents,
        selectedAgentId:
          remembered && agents.some((agent) => agent.id === remembered)
            ? remembered
            : null,
      };
      return { ok: true, data };
    }
    case "agent:remember": {
      const connection = await getConnection();
      if (connection) {
        await rememberAgentSelection(
          storage,
          connection.baseUrl,
          request.origin,
          request.agentId
        );
      }
      return { ok: true, data: {} };
    }
    case "overlay:closed": {
      await overlaySession.handleOverlayClosed(sender.tab?.id);
      return { ok: true, data: {} };
    }
  }
}

api.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
  if (isWorkerRequest(request)) {
    void handleWorkerRequest(request, buildName)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse(toErrorResponse(error)));
    return true;
  }
  if (isSafariRequest(request)) {
    void handleSafariRequest(request, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        const response = toErrorResponse(error);
        if (error instanceof ArmError) response.code = error.code;
        sendResponse(response);
      });
    return true;
  }
  return false;
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void overlaySession.handleTabGone(tabId);
});

api.tabs.onRemoved.addListener((tabId) => {
  void overlaySession.handleTabGone(tabId);
});

api.tabs.onActivated.addListener(({ tabId }) => {
  void overlaySession.handleTabActivated(tabId);
});
