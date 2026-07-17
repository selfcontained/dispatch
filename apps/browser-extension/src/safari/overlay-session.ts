import { api } from "../lib/extension-api";
import { classifyPickerPage } from "../lib/picker-access";
import type { ArmFailureCode } from "../types";

const OVERLAY_FILE = "feedback-overlay.js";
const ARMED_TAB_KEY = "dispatchArmedTabId";
const INJECT_ATTEMPTS = 4;
const INJECT_RETRY_MS = 150;

export class ArmError extends Error {
  constructor(
    readonly code: ArmFailureCode,
    message: string
  ) {
    super(message);
  }
}

function overlayIsReady(): boolean {
  return Boolean(
    window.__dispatchElementPickerCleanup &&
    document.querySelector("[data-dispatch-feedback-host]")
  );
}

function cleanupOverlay(): void {
  window.__dispatchElementPickerCleanup?.();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tracks which tab has the feedback overlay injected. The armed tab id is
 * mirrored into session storage so a restarted background worker can still
 * clean up. Safari-only; top frame only (no iframe selection in v1).
 */
export class OverlaySession {
  private armedTabId: number | null = null;

  private get sessionStorage(): chrome.storage.StorageArea {
    return api.storage.session ?? api.storage.local;
  }

  async arm(): Promise<void> {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new ArmError("inject-failed", "No active tab is available.");
    }
    if (classifyPickerPage(tab.url) !== "ready") {
      throw new ArmError(
        "unsupported-page",
        "This page cannot be inspected. Open a regular http(s) page and try again."
      );
    }

    await this.disarm({ cleanup: true }).catch(() => undefined);

    for (let attempt = 1; attempt <= INJECT_ATTEMPTS; attempt += 1) {
      try {
        await api.scripting.executeScript({
          target: { tabId: tab.id },
          files: [OVERLAY_FILE],
        });
      } catch {
        // Safari rejects injection when the extension has no access to the
        // site; the fix lives in Safari's own per-site settings.
        throw new ArmError(
          "no-site-access",
          "Dispatch Feedback is not allowed on this website yet."
        );
      }
      const ready = await this.probe(tab.id);
      if (ready) {
        await this.setArmedTab(tab.id);
        return;
      }
      await this.cleanupInTab(tab.id);
      await delay(INJECT_RETRY_MS);
    }
    throw new ArmError(
      "inject-failed",
      "The element selector could not start on this page. Reload the page and try again."
    );
  }

  async disarm(options: { cleanup: boolean }): Promise<void> {
    const tabId = await this.getArmedTab();
    if (tabId === null) return;
    await this.setArmedTab(null);
    if (options.cleanup) await this.cleanupInTab(tabId);
  }

  /** The overlay tore itself down (submitted/cancelled/failed). */
  async handleOverlayClosed(senderTabId: number | undefined): Promise<void> {
    const tabId = await this.getArmedTab();
    if (
      tabId !== null &&
      (senderTabId === undefined || senderTabId === tabId)
    ) {
      await this.setArmedTab(null);
    }
  }

  /** The armed tab started navigating or closed; the overlay died with it. */
  async handleTabGone(tabId: number): Promise<void> {
    if ((await this.getArmedTab()) === tabId) {
      await this.setArmedTab(null);
    }
  }

  /** The user switched tabs; remove the overlay so nothing lingers. */
  async handleTabActivated(activeTabId: number): Promise<void> {
    const tabId = await this.getArmedTab();
    if (tabId !== null && tabId !== activeTabId) {
      await this.setArmedTab(null);
      await this.cleanupInTab(tabId);
    }
  }

  private async probe(tabId: number): Promise<boolean> {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId },
        func: overlayIsReady,
      });
      return results.some((result) => result.result === true);
    } catch {
      return false;
    }
  }

  private async cleanupInTab(tabId: number): Promise<void> {
    await api.scripting
      .executeScript({ target: { tabId }, func: cleanupOverlay })
      .catch(() => undefined);
  }

  private async getArmedTab(): Promise<number | null> {
    if (this.armedTabId !== null) return this.armedTabId;
    const stored = await this.sessionStorage.get(ARMED_TAB_KEY);
    const tabId = stored[ARMED_TAB_KEY];
    return typeof tabId === "number" ? tabId : null;
  }

  private async setArmedTab(tabId: number | null): Promise<void> {
    this.armedTabId = tabId;
    if (tabId === null) {
      await this.sessionStorage.remove(ARMED_TAB_KEY);
    } else {
      await this.sessionStorage.set({ [ARMED_TAB_KEY]: tabId });
    }
  }
}
