// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserSelection, DispatchAgent } from "./types";

const PAGE_ORIGINS = ["http://*/*", "https://*/*"];
const TAB_ID = 7;
type PairingResult = {
  status: "pending" | "approved";
  token?: string;
};

const selectionFixture: BrowserSelection = {
  page: {
    url: "https://example.test/dashboard",
    title: "Dashboard",
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
  },
  element: {
    tagName: "button",
    selector: "#save",
    xpath: "//*[@id='save']",
    id: "save",
    classes: ["primary"],
    role: "button",
    accessibleName: "Save",
    text: "Save",
    outerHtml: '<button id="save">Save</button>',
    ancestors: [],
    nearbyElements: [],
    searchHints: ['id="save"'],
    rect: { x: 10, y: 20, width: 80, height: 32 },
  },
};

async function waitFor(assertion: () => void, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function setupPanel(
  initialPermission = false,
  connected = true,
  initialAgents: DispatchAgent[] = [
    { id: "agent-1", name: "Agent one", status: "running" },
  ]
) {
  let permissionGranted = initialPermission;
  let permissionRequestResult = true;
  let tabGetCount = 0;
  let failNextFileInjection = false;
  let selectDuringNextFileInjection = false;
  let agents = initialAgents;
  let nextAgentError: Error | null = null;
  let pairingStartCount = 0;
  let exchangeStartedCount = 0;
  let deferNextExchange = false;
  let resolveDeferredExchange:
    | ((result: { ok: true; data: PairingResult }) => void)
    | null = null;
  const lifecycleEvents: string[] = [];
  let pickerMessageListener:
    | ((message: unknown, sender: chrome.runtime.MessageSender) => void)
    | undefined;
  let tabActivatedListener:
    | ((activeInfo: chrome.tabs.TabActiveInfo) => void)
    | undefined;

  const permissionsRequest = vi.fn(async () => {
    permissionGranted = permissionRequestResult;
    return permissionRequestResult;
  });
  const tabsQuery = vi.fn(async () => [
    {
      id: TAB_ID,
      windowId: 1,
      status: "complete" as const,
      url: permissionGranted ? "https://example.test/dashboard" : undefined,
    },
  ]);
  const tabsGet = vi.fn(async () => {
    tabGetCount += 1;
    const url =
      permissionGranted && (initialPermission || tabGetCount > 1)
        ? "https://example.test/dashboard"
        : undefined;
    return { id: TAB_ID, windowId: 1, status: "complete" as const, url };
  });
  let fileInjectionCount = 0;
  let readinessProbeCount = 0;
  let cleanupCount = 0;
  let cleanupFailuresRemaining = 0;
  let deferNextCleanup = false;
  let resolveDeferredCleanup: (() => void) | null = null;
  const executeScript = vi.fn(
    async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
      if ("files" in injection) {
        fileInjectionCount += 1;
        if (failNextFileInjection) {
          failNextFileInjection = false;
          throw new Error("Cannot access contents of the page yet");
        }
        if (selectDuringNextFileInjection) {
          selectDuringNextFileInjection = false;
          pickerMessageListener?.(
            { type: "picker:selected", selection: selectionFixture },
            { tab: { id: TAB_ID } as chrome.tabs.Tab }
          );
        }
        return [{ frameId: 0 }];
      }
      if (
        "func" in injection &&
        injection.func.name === "injectedPickerIsReady"
      ) {
        readinessProbeCount += 1;
        return [
          { frameId: 0, result: true },
          { frameId: 3, result: true },
        ];
      }
      if (
        "func" in injection &&
        injection.func.name === "cleanupInjectedPicker"
      ) {
        cleanupCount += 1;
        if (deferNextCleanup) {
          deferNextCleanup = false;
          await new Promise<void>((resolve) => {
            resolveDeferredCleanup = resolve;
          });
        }
        if (cleanupFailuresRemaining > 0) {
          cleanupFailuresRemaining -= 1;
          throw new Error("Cleanup frame was temporarily unavailable");
        }
      }
      return [{ frameId: 0, result: true }];
    }
  );
  const sendMessage = vi.fn(async (request: { type: string }) => {
    lifecycleEvents.push(`worker:${request.type}`);
    if (request.type === "connection:status") {
      return {
        ok: true,
        data: connected
          ? { connected: true, baseUrl: "http://localhost:6767" }
          : { connected: false },
      };
    }
    if (request.type === "agents:list") {
      if (nextAgentError) {
        const error = nextAgentError;
        nextAgentError = null;
        throw error;
      }
      return {
        ok: true,
        data: { agents },
      };
    }
    if (request.type === "submission:create") {
      return { ok: true, data: {} };
    }
    if (request.type === "pairing:start") {
      pairingStartCount += 1;
      return {
        ok: true,
        data: {
          baseUrl: "https://dispatch.test",
          pairingId: `pairing-${pairingStartCount}`,
          pairingSecret: "pairing-secret",
          code: "ABCD-EFGH",
          verificationPath: "/settings/browser-extension",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    }
    if (request.type === "pairing:exchange") {
      exchangeStartedCount += 1;
      if (deferNextExchange) {
        deferNextExchange = false;
        return await new Promise<{ ok: true; data: PairingResult }>(
          (resolve) => {
            resolveDeferredExchange = resolve;
          }
        );
      }
      return { ok: true, data: { status: "pending" } };
    }
    if (request.type === "connection:disconnect") {
      return { ok: true, data: { revokedRemotely: true } };
    }
    throw new Error(`Unexpected worker request: ${request.type}`);
  });
  const permissionsRemove = vi.fn(async () => {
    lifecycleEvents.push("permissions:remove");
    permissionGranted = false;
    return true;
  });

  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: vi.fn(
          (
            listener: (
              message: unknown,
              sender: chrome.runtime.MessageSender
            ) => void
          ) => {
            pickerMessageListener = listener;
          }
        ),
      },
    },
    permissions: {
      contains: vi.fn(async () => permissionGranted),
      request: permissionsRequest,
      remove: permissionsRemove,
    },
    scripting: { executeScript },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: {
      query: tabsQuery,
      get: tabsGet,
      create: vi.fn(async () => ({ id: 9 })),
      onActivated: {
        addListener: vi.fn(
          (listener: (activeInfo: chrome.tabs.TabActiveInfo) => void) => {
            tabActivatedListener = listener;
          }
        ),
      },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
  });

  await import("./side-panel");
  await waitFor(() => {
    expect(
      document.querySelector(
        connected ? ".picker-toggle" : "input[name='dispatchUrl']"
      )
    ).not.toBeNull();
  });

  return {
    executeScript,
    tabsGet,
    permissionsRequest,
    permissionsRemove,
    get fileInjectionCount() {
      return fileInjectionCount;
    },
    get readinessProbeCount() {
      return readinessProbeCount;
    },
    get cleanupCount() {
      return cleanupCount;
    },
    get pairingStartCount() {
      return pairingStartCount;
    },
    get exchangeStartedCount() {
      return exchangeStartedCount;
    },
    lifecycleEvents,
    setPermissionGranted(granted: boolean) {
      permissionGranted = granted;
    },
    setPermissionRequestResult(result: boolean) {
      permissionRequestResult = result;
    },
    setAgents(nextAgents: DispatchAgent[]) {
      agents = nextAgents;
    },
    failNextAgentRefresh(message = "Could not refresh agents") {
      nextAgentError = new Error(message);
    },
    failNextFileInjection() {
      failNextFileInjection = true;
    },
    failCleanupAttempts(count: number) {
      cleanupFailuresRemaining = count;
    },
    deferNextCleanup() {
      deferNextCleanup = true;
    },
    resolveCleanup() {
      resolveDeferredCleanup?.();
      resolveDeferredCleanup = null;
    },
    deferNextExchange() {
      deferNextExchange = true;
    },
    resolveExchangeApproved() {
      resolveDeferredExchange?.({
        ok: true,
        data: { status: "approved", token: "late-token" },
      });
      resolveDeferredExchange = null;
    },
    selectDuringNextFileInjection() {
      selectDuringNextFileInjection = true;
    },
    sendPickerSelection() {
      pickerMessageListener?.(
        { type: "picker:selected", selection: selectionFixture },
        { tab: { id: TAB_ID } as chrome.tabs.Tab }
      );
    },
    sendPickerMessage(type: "picker:cancelled" | "picker:failed") {
      pickerMessageListener?.(
        { type },
        { tab: { id: TAB_ID } as chrome.tabs.Tab }
      );
    },
    activateTab(tabId: number, windowId = 1) {
      tabActivatedListener?.({ tabId, windowId });
    },
  };
}

describe("side panel picker flow", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = '<main id="app"></main>';
  });

  it("activates after a new broad permission propagates and can clear selection", async () => {
    const panel = await setupPanel();
    panel.failNextFileInjection();

    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();
    expect(panel.permissionsRequest).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        document.querySelector(".page-access-disclosure")?.textContent
      ).toContain("all HTTP and HTTPS websites");
    });
    (
      document.querySelector(
        ".page-access-actions .primary"
      ) as HTMLButtonElement
    ).click();

    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
    expect(panel.permissionsRequest).toHaveBeenCalledWith({
      origins: PAGE_ORIGINS,
    });
    expect(panel.fileInjectionCount).toBe(2);
    expect(panel.readinessProbeCount).toBe(1);
    expect(panel.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: TAB_ID, allFrames: true },
        files: ["picker.js"],
      })
    );

    const cleanupBeforeSelection = panel.cleanupCount;
    panel.sendPickerSelection();
    await waitFor(() =>
      expect(panel.cleanupCount).toBeGreaterThan(cleanupBeforeSelection)
    );
    expect(document.querySelector(".preview code")?.textContent).toBe("#save");
    const clear = document.querySelector(
      '[aria-label="Clear selected element"]'
    ) as HTMLButtonElement;
    expect(clear).not.toBeNull();
    clear.click();
    expect(document.querySelector(".preview")).toBeNull();
    expect(document.querySelector(".empty")?.textContent).toContain(
      "Select an element"
    );
  });

  it("accepts an immediate selection without probing or reinjecting", async () => {
    const panel = await setupPanel(true);
    panel.selectDuringNextFileInjection();

    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();

    await waitFor(() => {
      expect(document.querySelector(".preview code")?.textContent).toBe(
        "#save"
      );
    });
    expect(panel.fileInjectionCount).toBe(1);
    expect(panel.readinessProbeCount).toBe(0);
    expect(
      document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("explains broad and embedded-frame access before requesting and recovers from denial", async () => {
    const panel = await setupPanel();
    panel.setPermissionRequestResult(false);

    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();

    await waitFor(() => {
      expect(document.querySelector(".page-access-disclosure")).not.toBeNull();
    });
    const disclosure = document.querySelector(".page-access-disclosure");
    expect(disclosure?.textContent).toContain("all HTTP and HTTPS websites");
    expect(disclosure?.textContent).toContain("embedded frames");
    expect(panel.permissionsRequest).not.toHaveBeenCalled();
    (
      document.querySelector(
        ".page-access-actions .primary"
      ) as HTMLButtonElement
    ).click();

    await waitFor(() => {
      expect(
        document.querySelector(".page-access-disclosure")?.textContent
      ).toContain("Page access was denied");
    });
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Try page access again"
    );

    panel.setPermissionRequestResult(true);
    (
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Try page access again")
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
  });

  it("rechecks cached page access and settles after Chrome-side revocation", async () => {
    const panel = await setupPanel(true);
    panel.setPermissionGranted(false);

    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();

    await waitFor(() => {
      expect(document.querySelector(".page-access-disclosure")).not.toBeNull();
    });
    expect(panel.permissionsRequest).not.toHaveBeenCalled();
    (
      document.querySelector(
        ".page-access-actions .primary"
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
    expect(panel.permissionsRequest).toHaveBeenCalledTimes(1);
    expect(panel.tabsGet).toHaveBeenCalledTimes(2);
  });

  it.each(["picker:cancelled", "picker:failed"] as const)(
    "cleans every injected frame after %s",
    async (messageType) => {
      const panel = await setupPanel(true);
      (document.querySelector(".picker-toggle") as HTMLButtonElement).click();
      await waitFor(() => {
        expect(
          document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
        ).toBe("true");
      });
      const cleanupBefore = panel.cleanupCount;

      panel.sendPickerMessage(messageType);

      await waitFor(() => {
        expect(panel.cleanupCount).toBeGreaterThan(cleanupBefore);
      });
      expect(panel.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: TAB_ID, allFrames: true },
        })
      );
    }
  );

  it("keeps rapid re-arm disabled until terminal cleanup settles", async () => {
    const panel = await setupPanel(true);
    const selector = () =>
      document.querySelector(".picker-toggle") as HTMLButtonElement;
    selector().click();
    await waitFor(() => {
      expect(selector().getAttribute("aria-pressed")).toBe("true");
    });
    const injectionCount = panel.fileInjectionCount;

    panel.deferNextCleanup();
    panel.sendPickerMessage("picker:cancelled");

    expect(selector().getAttribute("aria-pressed")).toBe("false");
    expect(selector().disabled).toBe(true);
    selector().click();
    await flushAsyncWork();
    expect(panel.fileInjectionCount).toBe(injectionCount);

    panel.resolveCleanup();
    await waitFor(() => {
      expect(selector().disabled).toBe(false);
    });
    selector().click();
    await waitFor(() => {
      expect(selector().getAttribute("aria-pressed")).toBe("true");
    });
    expect(panel.fileInjectionCount).toBe(injectionCount + 1);
  });

  it("retries all-frame cleanup and reports an actionable exhaustion error", async () => {
    const panel = await setupPanel(true);
    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
    const cleanupBeforeRecovery = panel.cleanupCount;
    panel.failCleanupAttempts(1);
    panel.sendPickerMessage("picker:cancelled");
    await waitFor(() => {
      expect(panel.cleanupCount).toBe(cleanupBeforeRecovery + 2);
    });
    expect(document.querySelector("[role='alert']")).toBeNull();

    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
    const cleanupBeforeFailure = panel.cleanupCount;
    panel.failCleanupAttempts(3);
    panel.sendPickerMessage("picker:cancelled");
    await waitFor(() => {
      expect(panel.cleanupCount).toBe(cleanupBeforeFailure + 3);
      expect(document.querySelector("[role='alert']")?.textContent).toContain(
        "Reload the inspected page"
      );
    });
  });

  it("stops and cleans the picker with a notice when the active tab changes", async () => {
    const panel = await setupPanel(true);
    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
    const cleanupBefore = panel.cleanupCount;

    panel.activateTab(99, 1);

    await waitFor(() => {
      expect(document.querySelector(".status")?.textContent).toContain(
        "switched tabs"
      );
    });
    expect(panel.cleanupCount).toBeGreaterThan(cleanupBefore);
    expect(
      document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("refreshes agents while preserving selection and retains it on errors", async () => {
    const panel = await setupPanel(true, true, [
      { id: "agent-1", name: "Agent one", status: "running" },
      { id: "agent-2", name: "Agent two", status: "running" },
    ]);
    const select = document.querySelector(
      "#dispatch-agent"
    ) as HTMLSelectElement;
    select.value = "agent-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    panel.setAgents([
      { id: "agent-2", name: "Agent two", status: "running" },
      { id: "agent-3", name: "Agent three", status: "running" },
    ]);

    (
      document.querySelector(
        "[aria-label='Refresh running agents']"
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => {
      expect(
        (document.querySelector("#dispatch-agent") as HTMLSelectElement).value
      ).toBe("agent-2");
      expect(
        (
          document.querySelector(
            "[aria-label='Refresh running agents']"
          ) as HTMLButtonElement
        ).disabled
      ).toBe(false);
    });

    panel.failNextAgentRefresh("Agent refresh failed");
    (
      document.querySelector(
        "[aria-label='Refresh running agents']"
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => {
      const alert = document.querySelector("[role='alert']");
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("Agent refresh failed");
    });
    expect(
      (document.querySelector("#dispatch-agent") as HTMLSelectElement).value
    ).toBe("agent-2");
  });

  it("dismisses success without replacing a focused textarea or moving its caret", async () => {
    const panel = await setupPanel(true);
    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        document.querySelector(".picker-toggle")?.getAttribute("aria-pressed")
      ).toBe("true");
    });
    panel.sendPickerSelection();
    const initialTextarea = document.querySelector(
      "textarea"
    ) as HTMLTextAreaElement;
    initialTextarea.value = "Send this";
    initialTextarea.dispatchEvent(new Event("input", { bubbles: true }));

    vi.useFakeTimers();
    (
      document.querySelector("button.primary:last-child") as HTMLButtonElement
    ).click();
    await flushAsyncWork();
    expect(document.querySelector(".status.success")).not.toBeNull();
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Next thought";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(4, 4);

    vi.advanceTimersByTime(4_000);
    await flushAsyncWork();

    expect(document.querySelector("textarea")).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(4);
    expect(document.querySelector(".status.success")).toBeNull();
    vi.useRealTimers();
  });

  it("cancels pairing, revokes its new permission, and can restart immediately", async () => {
    const panel = await setupPanel(false, false);
    const input = document.querySelector(
      "input[name='dispatchUrl']"
    ) as HTMLInputElement;
    input.value = "https://dispatch.test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector("form") as HTMLFormElement).requestSubmit();

    await waitFor(() => {
      expect(document.querySelector("button")?.textContent).toBeTruthy();
      expect(
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "Cancel pairing"
        )
      ).toBe(true);
    });
    expect(
      (document.querySelector("input[name='dispatchUrl']") as HTMLInputElement)
        .disabled
    ).toBe(true);
    (
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel pairing"
      ) as HTMLButtonElement
    ).click();

    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "input[name='dispatchUrl']"
          ) as HTMLInputElement
        ).disabled
      ).toBe(false);
    });
    expect(panel.permissionsRemove).toHaveBeenCalledWith({
      origins: ["https://dispatch.test/*"],
    });

    (document.querySelector("form") as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(panel.pairingStartCount).toBe(2));
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Cancel pairing"
      )
    ).toBe(true);
    (
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel pairing"
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "input[name='dispatchUrl']"
          ) as HTMLInputElement
        ).disabled
      ).toBe(false);
    });
  });

  it("joins a late-approved exchange and disconnects before finishing cancellation", async () => {
    const panel = await setupPanel(false, false);
    panel.deferNextExchange();
    const input = document.querySelector(
      "input[name='dispatchUrl']"
    ) as HTMLInputElement;
    input.value = "https://dispatch.test";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    vi.useFakeTimers();
    (document.querySelector("form") as HTMLFormElement).requestSubmit();
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(2_500);
    await flushAsyncWork();
    expect(panel.exchangeStartedCount).toBe(1);

    (
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel pairing"
      ) as HTMLButtonElement
    ).click();
    await flushAsyncWork();
    expect(
      (document.querySelector("input[name='dispatchUrl']") as HTMLInputElement)
        .disabled
    ).toBe(true);

    panel.resolveExchangeApproved();
    await flushAsyncWork();

    const disconnectIndex = panel.lifecycleEvents.lastIndexOf(
      "worker:connection:disconnect"
    );
    const permissionRemovalIndex =
      panel.lifecycleEvents.lastIndexOf("permissions:remove");
    expect(disconnectIndex).toBeGreaterThan(-1);
    expect(permissionRemovalIndex).toBeGreaterThan(disconnectIndex);
    expect(
      (document.querySelector("input[name='dispatchUrl']") as HTMLInputElement)
        .disabled
    ).toBe(false);
    expect(document.querySelector(".status")?.textContent).toContain(
      "Pairing cancelled"
    );
    vi.useRealTimers();
  });
});
