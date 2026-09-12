// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchHarnessEnabledHintAtom } from "@/lib/store";

import {
  DISPATCH_HARNESS_ENDPOINT,
  useDispatchHarnessEnabled,
  useDispatchHarnessSetting,
} from "./use-dispatch-harness-enabled";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

const HINT_KEY = "dispatch:dispatchHarnessEnabledHint";

/** The setting and the flag read together, the way Settings and routing do. */
function renderBoth() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(
    () => ({
      setting: useDispatchHarnessSetting(),
      flag: useDispatchHarnessEnabled(),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
}

const isPost = (call: unknown[]) =>
  (call[1] as { method?: string } | undefined)?.method === "POST";

beforeEach(() => {
  window.localStorage.clear();
  getDefaultStore().set(dispatchHarnessEnabledHintAtom, null);
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useDispatchHarnessEnabled", () => {
  it("is off and unloaded on a browser that has never fetched the flag", () => {
    apiMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderBoth();
    expect(result.current.flag).toEqual({ enabled: false, loaded: false });
  });

  it("reads the flag from its own endpoint and remembers it", async () => {
    apiMock.mockResolvedValue({ enabled: true });
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.flag.enabled).toBe(true));
    expect(apiMock).toHaveBeenCalledWith(DISPATCH_HARNESS_ENDPOINT);
    await waitFor(() =>
      expect(window.localStorage.getItem(HINT_KEY)).toBe("true")
    );
  });

  it("answers from the remembered value before the fetch resolves", () => {
    getDefaultStore().set(dispatchHarnessEnabledHintAtom, true);
    apiMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderBoth();
    expect(result.current.flag).toEqual({ enabled: true, loaded: true });
  });
});

describe("useDispatchHarnessSetting", () => {
  // The card and the offered-types list read one cache, so a toggle has to
  // reach the reader without a refetch.
  it("writes through the same query the flag reads", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));
    expect(result.current.flag.enabled).toBe(false);

    apiMock.mockResolvedValue({ enabled: true });
    act(() => result.current.setting.setEnabled(true));

    await waitFor(() => expect(result.current.flag.enabled).toBe(true));
    const post = apiMock.mock.calls.find(isPost)!;
    expect(post[0]).toBe(DISPATCH_HARNESS_ENDPOINT);
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({
      enabled: true,
    });
  });

  it("reports its own message when a POST fails without one", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));

    apiMock.mockRejectedValue(new Error(""));
    act(() => result.current.setting.setEnabled(true));

    await waitFor(() =>
      expect(result.current.setting.error).toBe(
        "Failed to save Dispatch Harness setting."
      )
    );
    expect(result.current.flag.enabled).toBe(false);
  });
});
