// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { drawerStateAtomFamily } from "@/lib/store";
import { useDrawerState } from "./use-drawer-state";

afterEach(cleanup);
it.each([false, true])(
  "thread replaces sidebar open=%s while keeping tabs/pinning",
  (isOpen) => {
    const store = createStore();
    const atom = drawerStateAtomFamily(`thread-test-${isOpen}`);
    store.set(atom, { isOpen, activeTab: "files", isPinned: true });
    const options = {
      sidebarAgentId: `thread-test-${isOpen}`,
      isMobile: false,
      agentIds: [],
      mobileDrawerOpen: false,
      setMobileLeftOpen: vi.fn(),
      setMobileDrawerOpen: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ threadOpen }) => useDrawerState({ ...options, threadOpen }),
      {
        initialProps: { threadOpen: false },
        wrapper: ({ children }) => (
          <Provider store={store}>{children}</Provider>
        ),
      }
    );
    rerender({ threadOpen: true });
    expect(result.current.drawerOpen).toBe(false);
    rerender({ threadOpen: false });
    expect(store.get(atom)).toEqual({
      isOpen: false,
      activeTab: "files",
      isPinned: true,
    });
    act(() => result.current.setDrawerOpen(true));
    expect(result.current.drawerOpen).toBe(true);
  }
);
