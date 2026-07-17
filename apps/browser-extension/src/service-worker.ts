import { isWorkerRequest } from "./types";
import { handleWorkerRequest, toErrorResponse } from "./lib/worker-core";
import { buildDeviceName } from "./lib/device-name";

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    // Older managed Chrome builds can reject this until the extension is reloaded.
  });

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onMessage.addListener(
  (request: unknown, _sender, sendResponse) => {
    if (!isWorkerRequest(request)) return false;

    void handleWorkerRequest(request, buildDeviceName)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse(toErrorResponse(error));
      });
    return true;
  }
);
