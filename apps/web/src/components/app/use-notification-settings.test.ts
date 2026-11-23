// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import type {
  NotificationSettingsResponse,
  NotifyEventType,
} from "@/components/app/notification-settings-constants";

import { useNotificationSettings } from "./use-notification-settings";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/lib/web-notifications", () => ({
  getNotificationPermission: vi.fn(() => "default"),
  requestNotificationPermission: vi.fn(async () => "granted"),
}));

const { api } = await import("@/lib/api");
const { getNotificationPermission, requestNotificationPermission } =
  await import("@/lib/web-notifications");

const apiMock = vi.mocked(api);
const getPermissionMock = vi.mocked(getNotificationPermission);
const requestPermissionMock = vi.mocked(requestNotificationPermission);

const ALL_EVENTS: NotifyEventType[] = ["waiting_user", "blocked"];

function settings(
  overrides: Partial<NotificationSettingsResponse> = {}
): NotificationSettingsResponse {
  return {
    webNotifyEnabled: false,
    webNotifyEvents: ["waiting_user"],
    slackAwayDelaySeconds: 30,
    slackPresentDelayMinutes: 10,
    ...overrides,
  };
}

/** A promise plus its resolve/reject handles, for driving overlapping requests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render the hook with the initial GET already settled. */
async function renderLoaded(initial = settings()) {
  apiMock.mockResolvedValueOnce(initial);
  const view = renderHook(() => useNotificationSettings());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

/** The body sent with the Nth POST to the settings endpoint. */
function postBody(callIndex: number): Record<string, unknown> {
  const init = apiMock.mock.calls[callIndex]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  apiMock.mockReset();
  getPermissionMock.mockReset();
  getPermissionMock.mockReturnValue("default");
  requestPermissionMock.mockReset();
  requestPermissionMock.mockResolvedValue("granted");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useNotificationSettings — initial load", () => {
  it("adopts the server settings and clears loading", async () => {
    const { result } = await renderLoaded();

    expect(apiMock).toHaveBeenCalledWith("/api/v1/notifications/settings");
    expect(result.current.webNotifyEnabled).toBe(false);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user"]);
  });

  it("keeps defaults and still clears loading when the load fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("server starting"));
    const { result } = renderHook(() => useNotificationSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.webNotifyEnabled).toBe(false);
    expect(result.current.webNotifyEvents).toEqual(ALL_EVENTS);
    expect(result.current.saveStatus("enabled").state).toBe("idle");
  });
});

describe("useNotificationSettings — browser notification toggles", () => {
  it("persists an enable toggle and adopts the saved response", async () => {
    const { result } = await renderLoaded();

    apiMock.mockResolvedValueOnce(
      settings({ webNotifyEnabled: true, webNotifyEvents: ["waiting_user"] })
    );
    await act(async () => {
      await result.current.toggleWebNotifyEnabled(true);
    });

    expect(postBody(1)).toEqual({
      webNotifyEnabled: true,
      webNotifyEvents: ["waiting_user"],
    });
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.saveStatus("enabled").state).toBe("saved");
    expect(result.current.saveStatus("enabled").error).toBeUndefined();
  });

  it("rolls the enable toggle back to the saved value when the save fails", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["waiting_user"] })
    );

    const pending = deferred<NotificationSettingsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);

    // Toggle in its own act() so the optimistic render commits before the
    // failure lands, and rolling back is observably different from a no-op.
    let call!: Promise<void>;
    act(() => {
      call = result.current.toggleWebNotifyEnabled(true);
    });
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.saveStatus("enabled").state).toBe("saving");

    await act(async () => {
      pending.reject(new Error("disk full"));
      await call;
    });

    expect(result.current.webNotifyEnabled).toBe(false);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user"]);
    const status = result.current.saveStatus("enabled");
    expect(status.state).toBe("failed");
    expect(status.error).toEqual(new Error("disk full"));
  });

  it("persists an event toggle without changing the enabled flag", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: true, webNotifyEvents: ["waiting_user"] })
    );

    apiMock.mockResolvedValueOnce(
      settings({
        webNotifyEnabled: true,
        webNotifyEvents: ["waiting_user", "blocked"],
      })
    );
    await act(async () => {
      await result.current.toggleWebEvent("blocked");
    });

    expect(postBody(1)).toEqual({
      webNotifyEnabled: true,
      webNotifyEvents: ["waiting_user", "blocked"],
    });
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(result.current.webNotifyEnabled).toBe(true);
  });

  it("rolls an event toggle back to the saved set when the save fails", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: true, webNotifyEvents: ["waiting_user"] })
    );

    const pending = deferred<NotificationSettingsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);

    let call!: Promise<void>;
    act(() => {
      call = result.current.toggleWebEvent("waiting_user");
    });
    // Optimistic removal is visible, so restoring the saved set is
    // distinguishable from a no-op.
    expect(result.current.webNotifyEvents).toEqual([]);

    await act(async () => {
      pending.reject(new Error("nope"));
      await call;
    });

    expect(result.current.webNotifyEvents).toEqual(["waiting_user"]);
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.saveStatus("waiting_user").error).toEqual(
      new Error("nope")
    );
  });

  /** Enable, then pick an event while that first POST is still in flight. */
  async function startOverlappingSaves(
    result: { current: ReturnType<typeof useNotificationSettings> },
    first: ReturnType<typeof deferred<NotificationSettingsResponse>>,
    second: ReturnType<typeof deferred<NotificationSettingsResponse>>
  ) {
    apiMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let enable!: Promise<void>;
    let pick!: Promise<void>;
    await act(async () => {
      enable = result.current.toggleWebNotifyEnabled(true);
    });
    await act(async () => {
      pick = result.current.toggleWebEvent("blocked");
    });

    // Both show at once; only the first is sent until it settles, so the two
    // can never land out of order.
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(apiMock).toHaveBeenCalledTimes(2);
    return { enable, pick };
  }

  it("builds a queued save on what the one before it saved", async () => {
    const { result } = await renderLoaded(settings());
    const first = deferred<NotificationSettingsResponse>();
    const second = deferred<NotificationSettingsResponse>();
    const { enable, pick } = await startOverlappingSaves(result, first, second);

    await act(async () => {
      first.resolve(settings({ webNotifyEnabled: true }));
      await enable;
    });
    expect(postBody(2)).toEqual({
      webNotifyEnabled: true,
      webNotifyEvents: ["waiting_user", "blocked"],
    });
    expect(result.current.saveStatus("blocked").state).toBe("saving");

    await act(async () => {
      second.resolve(
        settings({
          webNotifyEnabled: true,
          webNotifyEvents: ["waiting_user", "blocked"],
        })
      );
      await pick;
    });
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(result.current.saveStatus("blocked").state).toBe("saved");
  });

  it("rolls back only the failed setting when another is queued behind it", async () => {
    const { result } = await renderLoaded(settings());
    const first = deferred<NotificationSettingsResponse>();
    const second = deferred<NotificationSettingsResponse>();
    const { enable, pick } = await startOverlappingSaves(result, first, second);

    await act(async () => {
      first.reject(new Error("offline"));
      await enable;
    });
    // The queued save doesn't carry the change that failed.
    expect(postBody(2)).toEqual({
      webNotifyEnabled: false,
      webNotifyEvents: ["waiting_user", "blocked"],
    });

    await act(async () => {
      second.resolve(
        settings({ webNotifyEvents: ["waiting_user", "blocked"] })
      );
      await pick;
    });
    expect(result.current.webNotifyEnabled).toBe(false);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(result.current.saveStatus("enabled").state).toBe("failed");
  });
});

describe("useNotificationSettings — browser permission", () => {
  it("re-reads the permission when the page becomes visible again", async () => {
    const { result } = await renderLoaded();
    expect(result.current.browserPermission).toBe("default");

    getPermissionMock.mockReturnValue("granted");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    // Restore even if an assertion below throws — a leaked `hidden === true`
    // would silently make the next test pass for the wrong reason.
    onTestFinished(() => hidden.mockRestore());

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Still hidden — the hook should not re-read yet.
    expect(result.current.browserPermission).toBe("default");

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.browserPermission).toBe("granted");
  });

  it("stops listening for visibility changes after unmount", async () => {
    const { unmount } = await renderLoaded();

    // Positive control: prove the listener is live before asserting it is gone,
    // so this cannot pass by never having been registered at all.
    const callsBeforeEvent = getPermissionMock.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getPermissionMock.mock.calls.length).toBeGreaterThan(
      callsBeforeEvent
    );

    const callsAtMount = getPermissionMock.mock.calls.length;
    unmount();
    document.dispatchEvent(new Event("visibilitychange"));

    expect(getPermissionMock.mock.calls.length).toBe(callsAtMount);
  });

  it("stores the result of a permission request", async () => {
    const { result } = await renderLoaded();
    requestPermissionMock.mockResolvedValueOnce("denied");

    await act(async () => {
      await result.current.handleRequestPermission();
    });

    expect(result.current.browserPermission).toBe("denied");
  });
});

describe("useNotificationSettings — handleTestWebNotification", () => {
  it("does nothing while permission has not been granted", async () => {
    const NotificationCtor = vi.fn();
    vi.stubGlobal(
      "Notification",
      Object.assign(NotificationCtor, { permission: "default" })
    );
    const { result } = await renderLoaded();

    act(() => result.current.handleTestWebNotification());

    expect(NotificationCtor).not.toHaveBeenCalled();
    expect(result.current.webMessage).toBe("");
  });

  it("shows a tagged notification once permission is granted", async () => {
    const NotificationCtor = vi.fn();
    vi.stubGlobal(
      "Notification",
      Object.assign(NotificationCtor, { permission: "granted" })
    );
    const { result } = await renderLoaded();

    act(() => result.current.handleTestWebNotification());

    expect(NotificationCtor).toHaveBeenCalledWith(
      "Dispatch test notification",
      expect.objectContaining({ tag: "dispatch-test" })
    );
    expect(result.current.webMessage).toBe(
      "Test notification sent — check your browser!"
    );
  });
});
