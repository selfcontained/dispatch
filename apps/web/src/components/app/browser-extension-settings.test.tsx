// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserExtensionSettings } from "./browser-extension-settings";

function renderSettings(search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/settings/connections${search}`]}>
        <BrowserExtensionSettings />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

function connectionsResponse(connections: unknown[] = []) {
  return new Response(JSON.stringify({ connections }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(connectionsResponse());
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
});

describe("BrowserExtensionSettings", () => {
  it("offers the extension download before showing manual setup steps", async () => {
    renderSettings();

    expect(await screen.findByText("Try browser feedback")).toBeTruthy();
    expect(screen.getByText(/select an element on any web app/i)).toBeTruthy();
    const download = screen.getByRole("link", {
      name: "Download extension ZIP",
    });
    expect(download.getAttribute("href")).toBe(
      "/dispatch-browser-feedback.zip"
    );
    expect(download.hasAttribute("download")).toBe(true);
    expect(screen.queryByText("Finish setup in Chrome")).toBe(null);
    expect(screen.queryByRole("button", { name: "Approve connection" })).toBe(
      null
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Already downloaded?" })
    );

    expect(await screen.findByText("Finish setup in Chrome")).toBeTruthy();
    expect(screen.getByText("2. Load the folder")).toBeTruthy();
    expect(screen.getByText("chrome://extensions")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy Dispatch URL" })
    ).toBeTruthy();
  });

  it("lists multiple paired browsers and revokes only the selected one", async () => {
    const fetchMock = vi
      .mocked(globalThis.fetch)
      .mockImplementation(async (input, init) => {
        if (init?.method === "DELETE") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return connectionsResponse([
          {
            id: "11111111-1111-4111-8111-111111111111",
            deviceName: "Work Chrome",
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            lastUsedAt: new Date(Date.now() - 30_000).toISOString(),
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            deviceName: "Laptop Chrome",
            createdAt: new Date(Date.now() - 120_000).toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            lastUsedAt: null,
          },
        ]);
      });
    renderSettings();

    expect(await screen.findByText("Work Chrome")).toBeTruthy();
    expect(screen.getByText("Laptop Chrome")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add another browser" })
    ).toBeTruthy();
    expect(screen.queryByText("Finish setup in Chrome")).toBe(null);

    fireEvent.click(
      screen.getByRole("button", { name: "Add another browser" })
    );
    expect(await screen.findByText("Finish setup in Chrome")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download ZIP" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Work Chrome" }));

    await waitFor(() => {
      expect(screen.queryByText("Work Chrome")).toBe(null);
    });
    expect(screen.getByText("Laptop Chrome")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/browser-extension/connections/11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ method: "DELETE", credentials: "include" })
    );
  });

  it("closes setup when a newly paired browser appears", async () => {
    let connections: unknown[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      connectionsResponse(connections)
    );
    renderSettings();

    await screen.findByText("Try browser feedback");
    fireEvent.click(
      screen.getByRole("button", { name: "Already downloaded?" })
    );
    expect(await screen.findByText("Finish setup in Chrome")).toBeTruthy();

    connections = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        deviceName: "New Chrome",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        lastUsedAt: null,
      },
    ];
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    expect(await screen.findByText("New Chrome")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Finish setup in Chrome")).toBe(null);
    });
    expect(
      screen
        .getByRole("button", { name: "Add another browser" })
        .getAttribute("aria-expanded")
    ).toBe("false");
  });

  it("keeps a large connection list compact until requested", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      connectionsResponse(
        Array.from({ length: 6 }, (_, index) => ({
          id: `00000000-0000-4000-8000-00000000000${index}`,
          deviceName: `Browser ${index + 1}`,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          lastUsedAt: null,
        }))
      )
    );
    renderSettings();

    expect(await screen.findByText("Browser 1")).toBeTruthy();
    expect(screen.queryByText("Browser 6")).toBe(null);

    fireEvent.click(
      screen.getByRole("button", { name: "Show 1 more browser" })
    );

    expect(await screen.findByText("Browser 6")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show fewer browsers" })
    ).toBeTruthy();
  });

  it("approves the pairing request and confirms the connection", async () => {
    let connectionsRequestCount = 0;
    const fetchMock = vi
      .mocked(globalThis.fetch)
      .mockImplementation(async (input) => {
        if (String(input).includes("/pairings/")) {
          return new Response(null, { status: 204 });
        }

        connectionsRequestCount += 1;
        const existingConnection = {
          id: "11111111-1111-4111-8111-111111111111",
          deviceName: "Existing Chrome",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          lastUsedAt: null,
        };
        return connectionsResponse([
          existingConnection,
          ...(connectionsRequestCount > 2
            ? [
                {
                  id: "33333333-3333-4333-8333-333333333333",
                  deviceName: "New Chrome",
                  createdAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                  lastUsedAt: null,
                },
              ]
            : []),
        ]);
      });
    renderSettings("?browserExtensionPairing=pairing-123&code=ABCD-1234");

    expect(
      screen.getByText("Chrome is requesting permission to connect")
    ).toBeTruthy();
    expect(
      screen.getByText("Confirm this code matches the extension")
    ).toBeTruthy();
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.queryByText("pairing-123")).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/browser-extension/pairings/pairing-123/approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ code: "ABCD-1234" }),
        }
      );
    });
    expect(await screen.findByText("Connection approved")).toBeTruthy();
    expect(screen.getByText("Existing Chrome")).toBeTruthy();
    await waitFor(() => expect(connectionsRequestCount).toBe(2));
    expect(screen.queryByText("New Chrome")).toBe(null);
    expect(await screen.findByText("New Chrome")).toBeTruthy();
    expect(screen.getByText("Browser extension connected")).toBeTruthy();
    expect(connectionsRequestCount).toBe(3);
  });

  it("keeps polling beyond one extension exchange interval", async () => {
    vi.useFakeTimers();
    let connectionsRequestCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input).includes("/pairings/")) {
        return new Response(null, { status: 204 });
      }

      connectionsRequestCount += 1;
      return connectionsResponse(
        connectionsRequestCount >= 8
          ? [
              {
                id: "44444444-4444-4444-8444-444444444444",
                deviceName: "Delayed Chrome",
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                lastUsedAt: null,
              },
            ]
          : []
      );
    });

    try {
      renderSettings("?browserExtensionPairing=delayed&code=123456");
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Approve connection" })
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Connection approved")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });

      expect(screen.getByText("Delayed Chrome")).toBeTruthy();
      expect(screen.getByText("Browser extension connected")).toBeTruthy();
      expect(connectionsRequestCount).toBeGreaterThan(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a retry after connection polling times out", async () => {
    vi.useFakeTimers();
    let connectionAvailable = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input).includes("/pairings/")) {
        return new Response(null, { status: 204 });
      }

      return connectionsResponse(
        connectionAvailable
          ? [
              {
                id: "55555555-5555-4555-8555-555555555555",
                deviceName: "Recovered Chrome",
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                lastUsedAt: null,
              },
            ]
          : []
      );
    });

    try {
      renderSettings("?browserExtensionPairing=slow&code=654321");
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Approve connection" })
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Connection approved")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_500);
      });

      expect(screen.getByText("Connection still pending")).toBeTruthy();
      expect(
        screen.getByText("Browser has not finished connecting")
      ).toBeTruthy();
      const retry = screen.getByRole("button", { name: "Check again" });

      connectionAvailable = true;
      fireEvent.click(retry);
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByText("Recovered Chrome")).toBeTruthy();
      expect(screen.getByText("Browser extension connected")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a timeout when a refetch finds the connection", async () => {
    vi.useFakeTimers();
    let connectionAvailable = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input).includes("/pairings/")) {
        return new Response(null, { status: 204 });
      }

      return connectionsResponse(
        connectionAvailable
          ? [
              {
                id: "66666666-6666-4666-8666-666666666666",
                deviceName: "Focus Chrome",
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                lastUsedAt: null,
              },
            ]
          : []
      );
    });

    try {
      const { queryClient } = renderSettings(
        "?browserExtensionPairing=focus&code=112233"
      );
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Approve connection" })
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Connection approved")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_500);
      });

      expect(screen.getByText("Connection still pending")).toBeTruthy();

      connectionAvailable = true;
      await act(async () => {
        await queryClient.refetchQueries({
          queryKey: ["browser-extension", "connections"],
        });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText("Focus Chrome")).toBeTruthy();
      expect(screen.getByText("Browser extension connected")).toBeTruthy();
      expect(screen.queryByText("Connection still pending")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a server error and allows the user to retry", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
      String(input).includes("/pairings/")
        ? new Response(JSON.stringify({ error: "Pairing request expired." }), {
            status: 410,
            headers: { "content-type": "application/json" },
          })
        : connectionsResponse()
    );
    renderSettings("?browserExtensionPairing=expired&code=OLD-CODE");

    fireEvent.click(screen.getByRole("button", { name: "Approve connection" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pairing request expired."
    );
    expect(
      screen
        .getByRole("button", { name: "Approve connection" })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  it("rejects an incomplete pairing link", () => {
    renderSettings("?browserExtensionPairing=pairing-123");

    expect(screen.getByRole("alert").textContent).toContain(
      "pairing link is incomplete"
    );
    expect(screen.queryByRole("button", { name: "Approve connection" })).toBe(
      null
    );
  });
});
