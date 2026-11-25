// @vitest-environment jsdom
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { useAuth } from "./use-auth";

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

function renderAuth() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useAuth(), { wrapper });
}

const failure = () => new Response("{}", { status: 500 });

it("reports a failure whose retry waits for focus, and Retry asks again", async () => {
  focusManager.setFocused(false);
  const fetch = vi.fn().mockImplementation(async () => failure());
  vi.stubGlobal("fetch", fetch);
  const { result } = renderAuth();

  expect(result.current.authState).toBe("loading");
  // The first backoff is a second, then the retry pauses.
  await waitFor(() => expect(result.current.authState).toBe("error"), {
    timeout: 3000,
  });
  expect(fetch).toHaveBeenCalledTimes(1);

  fetch.mockImplementation(async () =>
    Response.json({ passwordSet: false, authenticated: false, exposed: false })
  );
  act(() => result.current.retryAuth());
  await waitFor(() => expect(result.current.authState).toBe("authenticated"));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps loading while a failed request is still being retried", async () => {
  focusManager.setFocused(true);
  const fetch = vi.fn().mockImplementation(async () => failure());
  vi.stubGlobal("fetch", fetch);
  const { result } = renderAuth();

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  });
  expect(result.current.authState).toBe("loading");
});

it.each([400, 401, 500, 503])(
  "keeps the session state on logout %s and allows a successful retry",
  async (status) => {
    let authenticated = true;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/v1/auth/logout") {
        return new Response("Unavailable", { status });
      }
      return Response.json({
        passwordSet: true,
        authenticated,
        exposed: false,
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.authState).toBe("authenticated"));

    await act(async () => {
      await expect(result.current.handleLogout()).rejects.toThrow(
        `auth/logout ${status}`
      );
    });
    expect(result.current.authState).toBe("authenticated");
    // A rejected logout must not invalidate/refetch the cached session status.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/auth/logout", {
      method: "POST",
      credentials: "include",
    });

    fetch.mockImplementation(async (url: string) => {
      if (url === "/api/v1/auth/logout") {
        authenticated = false;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        passwordSet: true,
        authenticated,
        exposed: false,
      });
    });
    await act(async () => result.current.handleLogout());
    await waitFor(() => expect(result.current.authState).toBe("needs-login"));
    expect(fetch).toHaveBeenCalledTimes(4);
  }
);

it("keeps the signed-in state when the logout request rejects", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ passwordSet: true, authenticated: true, exposed: false })
    );
  vi.stubGlobal("fetch", fetch);
  const { result } = renderAuth();
  await waitFor(() => expect(result.current.authState).toBe("authenticated"));
  fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  await act(async () => {
    await expect(result.current.handleLogout()).rejects.toThrow(
      "Failed to fetch"
    );
  });
  expect(result.current.authState).toBe("authenticated");
  expect(fetch).toHaveBeenCalledTimes(2);
});
