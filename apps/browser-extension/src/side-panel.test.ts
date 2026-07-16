// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserSelection } from "./types";

const PAGE_ORIGINS = ["http://*/*", "https://*/*"];
const TAB_ID = 7;

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

async function setupPanel(initialPermission = false) {
  let permissionGranted = initialPermission;
  let tabGetCount = 0;
  let failNextFileInjection = false;
  let selectDuringNextFileInjection = false;
  let pickerMessageListener:
    | ((message: unknown, sender: chrome.runtime.MessageSender) => void)
    | undefined;

  const permissionsRequest = vi.fn(async () => {
    permissionGranted = true;
    return true;
  });
  const tabsQuery = vi.fn(async () => [
    {
      id: TAB_ID,
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
    return { id: TAB_ID, status: "complete" as const, url };
  });
  let fileInjectionCount = 0;
  let readinessProbeCount = 0;
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
      return [{ frameId: 0, result: true }];
    }
  );
  const sendMessage = vi.fn(async (request: { type: string }) => {
    if (request.type === "connection:status") {
      return {
        ok: true,
        data: { connected: true, baseUrl: "http://localhost:6767" },
      };
    }
    if (request.type === "agents:list") {
      return {
        ok: true,
        data: {
          agents: [{ id: "agent-1", name: "Agent one", status: "running" }],
        },
      };
    }
    throw new Error(`Unexpected worker request: ${request.type}`);
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
      remove: vi.fn(async () => true),
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
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
  });

  await import("./side-panel");
  await waitFor(() => {
    expect(document.querySelector(".picker-toggle")).not.toBeNull();
  });

  return {
    executeScript,
    permissionsRequest,
    get fileInjectionCount() {
      return fileInjectionCount;
    },
    get readinessProbeCount() {
      return readinessProbeCount;
    },
    failNextFileInjection() {
      failNextFileInjection = true;
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
  };
}

describe("side panel picker flow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = '<main id="app"></main>';
  });

  it("activates after a new broad permission propagates and can clear selection", async () => {
    const panel = await setupPanel();
    panel.failNextFileInjection();

    (document.querySelector(".picker-toggle") as HTMLButtonElement).click();

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

    panel.sendPickerSelection();
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
});
