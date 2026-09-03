// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatSurfaceEnabledHintAtom } from "@/lib/store";

import {
  useChatSurfaceEnabled,
  useChatSurfaceSetting,
} from "./use-chat-surface-enabled";

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

/** One pending promise per call, released (or failed) by the test. */
function deferredCalls() {
  const calls: Array<{
    args: unknown[];
    resolve: (value: { enabled: boolean }) => void;
    reject: (error: Error) => void;
  }> = [];
  apiMock.mockImplementation(
    (...args: unknown[]) =>
      new Promise<{ enabled: boolean }>((resolve, reject) => {
        calls.push({ args, resolve, reject });
      })
  );
  return calls;
}

function renderSetting() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const utils = renderHook(
    () => ({
      setting: useChatSurfaceSetting(),
      flag: useChatSurfaceEnabled(),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  return { ...utils, client };
}

const isPost = (call: { args: unknown[] }) =>
  (call.args[1] as { method?: string } | undefined)?.method === "POST";

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

describe("useChatSurfaceSetting", () => {
  it("issues one GET for the setting and the flag together", async () => {
    apiMock.mockResolvedValue({ enabled: true });
    const { result } = renderSetting();
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(result.current.setting.enabled).toBe(true);
    expect(result.current.flag.enabled).toBe(true);
  });

  it("keeps a toggle made while the initial GET is still in flight", async () => {
    // Under latency the GET can land after the user has already flipped the
    // switch and the POST has succeeded; its stale value must not win.
    const calls = deferredCalls();
    const { result } = renderSetting();
    expect(result.current.setting.loaded).toBe(false);
    const initialGet = calls[0];

    act(() => result.current.setting.setEnabled(true));
    await waitFor(() => expect(result.current.setting.enabled).toBe(true));
    expect(result.current.setting.loaded).toBe(true);
    expect(result.current.flag.enabled).toBe(true);

    const post = calls.find(isPost)!;
    expect(JSON.parse((post.args[1] as { body: string }).body)).toEqual({
      enabled: true,
    });
    post.resolve({ enabled: true });
    // The slow GET finally answers with the pre-toggle value.
    initialGet.resolve({ enabled: false });
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.setting.enabled).toBe(true);
    expect(result.current.flag.enabled).toBe(true);
    expect(window.localStorage.getItem(HINT_KEY)).toBe("true");
    // No second GET was issued to "confirm" the toggle.
    expect(calls.filter((c) => !isPost(c))).toHaveLength(1);
  });

  it("rolls back to the confirmed value when the POST fails", async () => {
    const calls = deferredCalls();
    const { result } = renderSetting();
    calls[0].resolve({ enabled: false });
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));

    act(() => result.current.setting.setEnabled(true));
    await waitFor(() => expect(result.current.setting.enabled).toBe(true));
    calls.find(isPost)!.reject(new Error("nope"));

    await waitFor(() => expect(result.current.setting.enabled).toBe(false));
    expect(result.current.flag.enabled).toBe(false);
    expect(result.current.setting.error).toBe("nope");

    // The next toggle clears the error.
    act(() => result.current.setting.setEnabled(true));
    await waitFor(() => expect(result.current.setting.error).toBe(""));
  });

  it("lets only the newest of two quick toggles settle the cache", async () => {
    const calls = deferredCalls();
    const { result } = renderSetting();
    calls[0].resolve({ enabled: false });
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));

    act(() => result.current.setting.setEnabled(true));
    await waitFor(() => expect(result.current.setting.enabled).toBe(true));
    act(() => result.current.setting.setEnabled(false));
    await waitFor(() => expect(result.current.setting.enabled).toBe(false));

    const posts = calls.filter(isPost);
    expect(posts).toHaveLength(2);
    // The older write fails after the newer one was issued: no rollback.
    posts[0].reject(new Error("late failure"));
    posts[1].resolve({ enabled: false });
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.setting.enabled).toBe(false);
    expect(result.current.setting.error).toBe("");
  });
});
