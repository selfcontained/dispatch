// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatSurfaceEnabledHintAtom } from "@/lib/store";

import { useChatSurfaceEnabled } from "./use-chat-surface-enabled";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

const HINT_KEY = "dispatch:chatSurfaceEnabledHint";

function renderFlag() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useChatSurfaceEnabled(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** A fetch that stays pending until the test releases it. */
function deferredFetch() {
  let resolve!: (value: { enabled: boolean }) => void;
  apiMock.mockReturnValue(
    new Promise<{ enabled: boolean }>((r) => {
      resolve = r;
    })
  );
  return resolve;
}

beforeEach(() => {
  window.localStorage.clear();
  getDefaultStore().set(chatSurfaceEnabledHintAtom, null);
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useChatSurfaceEnabled", () => {
  it("is unloaded on a browser that has never fetched the flag", () => {
    deferredFetch();
    const { result } = renderFlag();
    expect(result.current).toEqual({ enabled: false, loaded: false });
  });

  // The first paint of an agent view must already know the answer, or the
  // Console shows before the Chat tab takes over.
  it("answers from the remembered value before the fetch resolves", () => {
    getDefaultStore().set(chatSurfaceEnabledHintAtom, true);
    deferredFetch();
    const { result } = renderFlag();
    expect(result.current).toEqual({ enabled: true, loaded: true });
  });

  it("lets the server override a stale hint and remembers the new value", async () => {
    getDefaultStore().set(chatSurfaceEnabledHintAtom, true);
    const resolve = deferredFetch();
    const { result } = renderFlag();
    expect(result.current.enabled).toBe(true);

    resolve({ enabled: false });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.loaded).toBe(true);
    await waitFor(() =>
      expect(window.localStorage.getItem(HINT_KEY)).toBe("false")
    );
  });

  it("remembers the first fetched value for the next visit", async () => {
    apiMock.mockResolvedValue({ enabled: true });
    const { result } = renderFlag();
    await waitFor(() =>
      expect(result.current).toEqual({ enabled: true, loaded: true })
    );
    expect(window.localStorage.getItem(HINT_KEY)).toBe("true");
  });
});
