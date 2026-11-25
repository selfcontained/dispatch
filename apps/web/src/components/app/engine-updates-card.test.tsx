// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { MacAppUpdateSnapshot } from "@dispatch/shared";
import { MAC_APP_UPDATE_QUERY_KEY } from "@/hooks/use-mac-app-update";
import {
  EngineUpdatesCard,
  RECONNECT_GRACE_MS,
  RESTART_GRACE_MS,
  enginesLoadState,
} from "./engine-updates-card";

const { api, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
    }
  }
  return { api: vi.fn(), ApiError };
});
vi.mock("@/lib/api", () => ({ api, ApiError }));

const ENGINES = {
  canManage: true,
  engines: [
    {
      id: "claude",
      label: "Claude Code",
      install: "npm i -g @anthropic-ai/claude-code",
      installed: true,
      version: "2.1.0",
      path: "/usr/local/bin/claude",
    },
  ],
};

const offline = (): Promise<never> =>
  Promise.reject(new TypeError("Failed to fetch"));

function renderCard(mac?: MacAppUpdateSnapshot): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (mac) client.setQueryData(MAC_APP_UPDATE_QUERY_KEY, mac);
  render(
    <QueryClientProvider client={client}>
      <EngineUpdatesCard />
    </QueryClientProvider>
  );
  return client;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const errorAlert = () => screen.queryByText("Couldn’t load engines.");

describe("enginesLoadState", () => {
  const base = { failingSince: 0, restartExpected: false };
  it("is ok without an error", () => {
    expect(
      enginesLoadState({ ...base, isError: false, error: null, now: 1 })
    ).toBe("ok");
  });
  it("reconnects through a short outage, then fails", () => {
    const error = new TypeError("Failed to fetch");
    expect(enginesLoadState({ ...base, isError: true, error, now: 1 })).toBe(
      "reconnecting"
    );
    expect(
      enginesLoadState({
        ...base,
        isError: true,
        error,
        now: RECONNECT_GRACE_MS,
      })
    ).toBe("failed");
  });
  it("waits longer while an update restarts the server", () => {
    const error = new ApiError(503, "unavailable");
    const restarting = { ...base, isError: true, error, restartExpected: true };
    expect(enginesLoadState({ ...restarting, now: RECONNECT_GRACE_MS })).toBe(
      "restarting"
    );
    expect(enginesLoadState({ ...restarting, now: RESTART_GRACE_MS })).toBe(
      "failed"
    );
  });
  it("fails at once when the server answers with an error", () => {
    expect(
      enginesLoadState({
        ...base,
        isError: true,
        error: new ApiError(500, "probe crashed"),
        restartExpected: true,
        now: 1,
      })
    ).toBe("failed");
  });
});

describe("EngineUpdatesCard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps cached engines through a brief outage and recovers on its own", async () => {
    api.mockResolvedValueOnce(ENGINES);
    renderCard();
    await advance(0);
    expect(screen.getByText("Claude Code")).toBeTruthy();

    api.mockImplementation(offline);
    await advance(5_100);
    expect(screen.getByRole("status").textContent).toContain(
      "Reconnecting to Dispatch"
    );
    expect(errorAlert()).toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();

    api.mockReset();
    api.mockResolvedValue(ENGINES);
    await advance(5_100);
    expect(screen.queryByRole("status")).toBeNull();
    expect(errorAlert()).toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();
  });

  it("shows Retry and Details once an outage lasts, with cached data kept", async () => {
    api.mockResolvedValueOnce(ENGINES);
    renderCard();
    await advance(0);
    api.mockImplementation(offline);
    await advance(5_100);
    expect(errorAlert()).toBeNull();
    await advance(RECONNECT_GRACE_MS);
    expect(errorAlert()).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    // Background polls must not make Retry look busy.
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Details")).toBeTruthy();
  });

  it("waits out a Mac app install restart, then recovers", async () => {
    api.mockResolvedValueOnce(ENGINES);
    renderCard({
      connected: true,
      state: {
        version: "1.7.37",
        phase: "installing",
        availableVersion: "1.7.38",
        checkedAt: null,
        error: null,
        automatic: true,
      },
    });
    await advance(0);
    api.mockImplementation(offline);
    await advance(5_100);
    await advance(RECONNECT_GRACE_MS + 10_000);
    expect(screen.getByRole("status").textContent).toContain(
      "restarting to finish the update"
    );
    expect(errorAlert()).toBeNull();

    api.mockReset();
    api.mockResolvedValue(ENGINES);
    await advance(5_100);
    expect(screen.queryByRole("status")).toBeNull();
    expect(errorAlert()).toBeNull();
  });

  it("does not hide a real error just because a download is active", async () => {
    api.mockResolvedValueOnce(ENGINES);
    renderCard({
      connected: true,
      state: {
        version: "1.7.37",
        phase: "downloading",
        availableVersion: "1.7.38",
        checkedAt: null,
        error: null,
        automatic: true,
      },
    });
    await advance(0);
    api.mockRejectedValue(new ApiError(500, "probe crashed"));
    await advance(5_100);
    expect(errorAlert()).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
  });

  it("offers Retry when the first load never succeeds", async () => {
    api.mockImplementation(offline);
    renderCard();
    await advance(0);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByLabelText("Checking engine installations")).toBeTruthy();
    expect(errorAlert()).toBeNull();

    await advance(RECONNECT_GRACE_MS + 100);
    expect(errorAlert()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    api.mockReset();
    api.mockResolvedValue(ENGINES);
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(errorAlert()).toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();
  });
});
