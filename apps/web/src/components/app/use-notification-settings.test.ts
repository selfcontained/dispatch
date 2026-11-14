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
    expect(result.current.webError).toBe("");
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
    expect(result.current.webMessage).toBe(
      "Browser notification settings saved."
    );
    expect(result.current.webError).toBe("");
    expect(result.current.saving).toBe(false);
  });

  it("rolls the enable toggle back to the saved value when the save fails", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["waiting_user"] })
    );

    const pending = deferred<NotificationSettingsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);

    // Toggle in its own act() so the optimistic render commits and the ref
    // sync runs before the failure lands. That is what makes the rollback
    // target meaningful: webNotifyEnabledRef now holds the optimistic `true`,
    // so rolling back to savedWebEnabledRef (`false`) is observably different
    // from rolling back to the current value.
    let call!: Promise<void>;
    act(() => {
      call = result.current.toggleWebNotifyEnabled(true);
    });
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.saving).toBe(true);

    await act(async () => {
      pending.reject(new Error("disk full"));
      await call;
    });

    expect(result.current.webNotifyEnabled).toBe(false);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user"]);
    expect(result.current.webError).toBe("disk full");
    expect(result.current.webMessage).toBe("");
    expect(result.current.saving).toBe(false);
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
    // Optimistic removal is visible, and webNotifyEventsRef has been synced to
    // it, so restoring savedWebEventsRef is distinguishable from a no-op.
    expect(result.current.webNotifyEvents).toEqual([]);

    await act(async () => {
      pending.reject(new Error("nope"));
      await call;
    });

    expect(result.current.webNotifyEvents).toEqual(["waiting_user"]);
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.webError).toBe("nope");
    expect(result.current.saving).toBe(false);
  });

  /**
   * Start two overlapping saves the way a user produces them: enable browser
   * notifications, then toggle an event while the first POST is still in
   * flight. The two toggles go in separate act() calls so the ref-sync effect
   * commits in between — exactly as it would between two real clicks. Doing
   * both in one act() would leave `webNotifyEnabledRef` stale and make the
   * second request post `webNotifyEnabled: false`, which is not a state the UI
   * can actually reach.
   */
  async function startOverlappingSaves(
    result: { current: ReturnType<typeof useNotificationSettings> },
    older: ReturnType<typeof deferred<NotificationSettingsResponse>>,
    newer: ReturnType<typeof deferred<NotificationSettingsResponse>>
  ) {
    apiMock
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.toggleWebNotifyEnabled(true);
    });
    act(() => {
      second = result.current.toggleWebEvent("blocked");
    });

    // Both requests carry the enabled flag the user actually set; the newer one
    // builds on the older one's optimistic state rather than reverting it.
    expect(postBody(1)).toEqual({
      webNotifyEnabled: true,
      webNotifyEvents: ["waiting_user"],
    });
    expect(postBody(2)).toEqual({
      webNotifyEnabled: true,
      webNotifyEvents: ["waiting_user", "blocked"],
    });
    return { first, second };
  }

  const WON: NotificationSettingsResponse = settings({
    webNotifyEnabled: true,
    webNotifyEvents: ["waiting_user", "blocked"],
  });
  const SUPERSEDED: NotificationSettingsResponse = settings({
    webNotifyEnabled: false,
    webNotifyEvents: [],
  });

  it("keeps saving true when a superseded response lands while a newer save is in flight", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["waiting_user"] })
    );

    const older = deferred<NotificationSettingsResponse>();
    const newer = deferred<NotificationSettingsResponse>();
    const { first, second } = await startOverlappingSaves(result, older, newer);

    // The superseded request settles first: it must neither apply its payload
    // nor drop the saving flag while the newer request is still outstanding.
    await act(async () => {
      older.resolve(SUPERSEDED);
      await first;
    });
    expect(result.current.saving).toBe(true);
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(result.current.webMessage).toBe("");

    await act(async () => {
      newer.resolve(WON);
      await second;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
  });

  it("ignores a slow response that lands after a newer save already won", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["waiting_user"] })
    );

    const older = deferred<NotificationSettingsResponse>();
    const newer = deferred<NotificationSettingsResponse>();
    const { first, second } = await startOverlappingSaves(result, older, newer);

    // The newer request settles first and wins.
    await act(async () => {
      newer.resolve(WON);
      await second;
    });
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(result.current.saving).toBe(false);

    // The stale response must not clobber it, or re-enter the saving state.
    await act(async () => {
      older.resolve(SUPERSEDED);
      await first;
    });
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
    expect(result.current.saving).toBe(false);
  });

  it("does not roll back when a stale save rejects after a newer one won", async () => {
    const { result } = await renderLoaded(
      settings({ webNotifyEnabled: false, webNotifyEvents: ["waiting_user"] })
    );

    const older = deferred<NotificationSettingsResponse>();
    const newer = deferred<NotificationSettingsResponse>();
    const { first, second } = await startOverlappingSaves(result, older, newer);

    await act(async () => {
      newer.resolve(WON);
      await second;
    });

    await act(async () => {
      older.reject(new Error("stale failure"));
      await first;
    });

    expect(result.current.webError).toBe("");
    expect(result.current.webNotifyEnabled).toBe(true);
    expect(result.current.webNotifyEvents).toEqual(["waiting_user", "blocked"]);
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
