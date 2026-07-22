// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationSettingsResponse } from "@/components/app/notification-settings-constants";

import { NotificationSettings } from "./notification-settings";

// The component renders the real useNotificationSettings hook; only its I/O
// seams are mocked so the assertions exercise the wiring from hook -> sections.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/lib/web-notifications", () => ({
  getNotificationPermission: vi.fn(() => "default"),
  requestNotificationPermission: vi.fn(async () => "granted"),
}));

const { api } = await import("@/lib/api");
const { getNotificationPermission } = await import("@/lib/web-notifications");

const apiMock = vi.mocked(api);
const getPermissionMock = vi.mocked(getNotificationPermission);

function settings(
  overrides: Partial<NotificationSettingsResponse> = {}
): NotificationSettingsResponse {
  return {
    webhookUrl: "https://hooks.slack.com/services/T/B/X",
    notifyEvents: ["done", "blocked"],
    webNotifyEnabled: false,
    webNotifyEvents: ["done"],
    ...overrides,
  };
}

/** A promise plus its resolve/reject handles, for driving in-flight requests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The body sent with the Nth api() call. */
function postBody(callIndex: number): Record<string, unknown> {
  const init = apiMock.mock.calls[callIndex]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/** Render with the initial settings GET already settled. */
async function renderLoaded(
  initial = settings(),
  permission: NotificationPermission = "default"
) {
  getPermissionMock.mockReturnValue(permission);
  apiMock.mockResolvedValueOnce(initial);
  const view = render(<NotificationSettings />);
  // The sections only mount once loading clears, so waiting for the Save button
  // proves the initial GET was adopted.
  await screen.findByTestId("save-notification-settings");
  return view;
}

/** The Browser Notifications section wrapper, used to scope status assertions. */
function browserSection(): HTMLElement {
  const heading = screen.getByRole("heading", {
    name: "Browser Notifications",
  });
  const section = heading.closest("div");
  if (!section) throw new Error("browser section wrapper not found");
  return section;
}

beforeEach(() => {
  apiMock.mockReset();
  getPermissionMock.mockReset();
  getPermissionMock.mockReturnValue("default");
  // jsdom has no matchMedia; the browser section reads it for the standalone
  // (PWA) check on every render.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  // The section gates on `typeof Notification`; give it a stub so the toggle UI
  // (not the "unsupported" fallback) renders.
  vi.stubGlobal(
    "Notification",
    Object.assign(vi.fn(), { permission: "granted" as NotificationPermission })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NotificationSettings — Slack save gating", () => {
  it("disables Save until there are changes and reflects the saving state", async () => {
    await renderLoaded();

    const save = screen.getByTestId("save-notification-settings");
    // Loaded values match the saved baseline, so nothing is dirty yet.
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByTestId("slack-webhook-url"), {
      target: { value: "https://hooks.slack.com/services/T/B/Y" },
    });
    expect(save.hasAttribute("disabled")).toBe(false);

    // Hold the POST open so the transient saving state is observable.
    const pending = deferred<NotificationSettingsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);
    fireEvent.click(save);
    expect(save.textContent).toBe("Saving...");
    expect(save.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      pending.resolve(
        settings({ webhookUrl: "https://hooks.slack.com/services/T/B/Y" })
      );
      await pending.promise;
    });

    // The server response becomes the new baseline: Save settles back to idle
    // and disabled, and the success message lands in the Slack section.
    expect(save.textContent).toBe("Save");
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Settings saved.")).toBeTruthy();
    expect(postBody(1)).toEqual({
      webhookUrl: "https://hooks.slack.com/services/T/B/Y",
      notifyEvents: ["done", "blocked"],
      webNotifyEnabled: false,
      webNotifyEvents: ["done"],
    });
  });
});

describe("NotificationSettings — browser toggle wiring", () => {
  it("persists an enable toggle and shows the saved message in the browser section", async () => {
    await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["done"] }),
      "granted"
    );

    apiMock.mockResolvedValueOnce(
      settings({ webNotifyEnabled: true, webNotifyEvents: ["done"] })
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("web-notify-enabled"));
    });

    // The toggle drove a browser-settings POST (enabled flag + events only).
    expect(postBody(1)).toEqual({
      webNotifyEnabled: true,
      webNotifyEvents: ["done"],
    });
    // Success copy renders in the Browser section, and only there.
    const saved = screen.getAllByText("Browser notification settings saved.");
    expect(saved).toHaveLength(1);
    expect(
      within(browserSection()).getByText("Browser notification settings saved.")
    ).toBeTruthy();
  });
});

describe("NotificationSettings — status slots do not cross-wire", () => {
  it("shows a browser-save failure only in the browser section", async () => {
    await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["done"] }),
      "granted"
    );

    apiMock.mockRejectedValueOnce(new Error("browser save boom"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("web-notify-enabled"));
    });

    // webError must land in the Browser section's slot (which reads webError),
    // never leak into the Slack section's error slot (which reads error).
    expect(screen.getAllByText("browser save boom")).toHaveLength(1);
    expect(
      within(browserSection()).getByText("browser save boom")
    ).toBeTruthy();
  });

  it("shows a Slack save failure only in the Slack section", async () => {
    await renderLoaded(settings(), "granted");

    fireEvent.change(screen.getByTestId("slack-webhook-url"), {
      target: { value: "https://example.test/x" },
    });
    apiMock.mockRejectedValueOnce(new Error("slack save boom"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-notification-settings"));
    });

    // error must land in the Slack section, never in the Browser section's
    // webError slot.
    expect(screen.getByText("slack save boom")).toBeTruthy();
    expect(within(browserSection()).queryByText("slack save boom")).toBeNull();
  });
});

describe("NotificationSettings — permission gating", () => {
  it("gates the enable toggle and test button behind granted permission", async () => {
    await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["done"] }),
      "default"
    );

    // Without permission: the Allow button shows, the enable toggle is
    // disabled, and there is no test button.
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(
      screen.getByTestId("web-notify-enabled").hasAttribute("disabled")
    ).toBe(true);
    expect(screen.queryByTestId("test-web-notification")).toBeNull();
  });

  it("hides the event toggles and test button when permission is revoked while enabled", async () => {
    // A saved `webNotifyEnabled: true` can outlive its permission (revoked in
    // browser/OS settings). The whole event + test block must stay behind the
    // permission gate, not just the enabled flag.
    await renderLoaded(
      settings({ webNotifyEnabled: true, webNotifyEvents: ["done"] }),
      "default"
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.queryByTestId("test-web-notification")).toBeNull();
    expect(screen.queryByTestId("web-notify-event-done")).toBeNull();
  });

  it("exposes and wires the test button once permission is granted and enabled", async () => {
    await renderLoaded(
      settings({ webNotifyEnabled: true, webNotifyEvents: ["done"] }),
      "granted"
    );

    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    const testButton = screen.getByTestId("test-web-notification");
    expect(testButton).toBeTruthy();

    const NotificationCtor = vi.mocked(
      globalThis.Notification as unknown as ReturnType<typeof vi.fn>
    );
    fireEvent.click(testButton);
    expect(NotificationCtor).toHaveBeenCalledWith(
      "Dispatch test notification",
      expect.objectContaining({ tag: "dispatch-test" })
    );
  });
});
