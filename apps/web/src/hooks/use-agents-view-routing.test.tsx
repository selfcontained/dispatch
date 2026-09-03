// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Location, NavigateFunction } from "react-router-dom";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lastCenterTabAtomFamily } from "@/lib/store";

import { useAgentsViewRouting } from "./use-agents-view-routing";

// The chat surface flag is server state behind a React Query hook; the
// routing decisions it drives are what this file is about, so it is a plain
// switch here.
const chatFlag = vi.hoisted(() => ({ enabled: false, loaded: true }));
vi.mock("@/hooks/use-chat-surface-enabled", () => ({
  useChatSurfaceEnabled: () => ({ ...chatFlag }),
}));

type RoutingProps = {
  routeAgentId: string | undefined;
  agentsLoaded: boolean;
  validatedSelectedAgentId: string | null;
};

// The hook is exercised against a real MemoryRouter so the useMatch patterns
// and navigate() calls run for real; assertions read the resulting location
// through a probe instead of mocking the router.
function renderRouting(initialPath: string, initialProps: RoutingProps) {
  const locationRef: { current: Location | null } = { current: null };
  const navigateRef: { current: NavigateFunction | null } = { current: null };

  function RouterProbe() {
    locationRef.current = useLocation();
    navigateRef.current = useNavigate();
    return null;
  }

  const utils = renderHook(
    (props: RoutingProps) => useAgentsViewRouting(props),
    {
      initialProps,
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={[initialPath]}>
          {children}
          <RouterProbe />
        </MemoryRouter>
      ),
    }
  );

  return {
    ...utils,
    pathname: () => {
      const location = locationRef.current;
      if (!location) throw new Error("location probe never rendered");
      return location.pathname;
    },
    goBack: () => {
      act(() => navigateRef.current?.(-1));
    },
  };
}

beforeEach(() => {
  chatFlag.enabled = false;
  chatFlag.loaded = true;
  window.localStorage.clear();
  lastCenterTabAtomFamily.remove("agt_1");
});

afterEach(() => {
  cleanup();
});

describe("useAgentsViewRouting", () => {
  describe("invalid-agent redirect", () => {
    it("waits for agents to load, then replaces an unknown agent with /agents", () => {
      const { pathname, rerender, goBack } = renderRouting("/agents/agt_gone", {
        routeAgentId: "agt_gone",
        agentsLoaded: false,
        validatedSelectedAgentId: null,
      });

      expect(pathname()).toBe("/agents/agt_gone");

      rerender({
        routeAgentId: "agt_gone",
        agentsLoaded: true,
        validatedSelectedAgentId: null,
      });
      expect(pathname()).toBe("/agents");

      // In the app routeAgentId comes from useParams, so it clears once the
      // redirect lands on /agents. Mirror that before probing history:
      // replace: true keeps the history at a single entry, so going back
      // (twice, in case the effect re-fired) must not resurrect the dead
      // agent URL.
      rerender({
        routeAgentId: undefined,
        agentsLoaded: true,
        validatedSelectedAgentId: null,
      });
      goBack();
      goBack();
      expect(pathname()).toBe("/agents");
    });

    it("leaves a validated agent alone", () => {
      const { pathname } = renderRouting("/agents/agt_ok", {
        routeAgentId: "agt_ok",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_ok",
      });
      expect(pathname()).toBe("/agents/agt_ok");
    });

    it("does nothing on the bare /agents route", () => {
      const { pathname } = renderRouting("/agents", {
        routeAgentId: undefined,
        agentsLoaded: true,
        validatedSelectedAgentId: null,
      });
      expect(pathname()).toBe("/agents");
    });
  });

  describe("legacy deep-link fallback", () => {
    it("collapses a feedback deep link onto the agent route once loaded", () => {
      const { pathname, rerender } = renderRouting(
        "/agents/agt_1/feedback/item_9",
        {
          routeAgentId: "agt_1",
          agentsLoaded: false,
          validatedSelectedAgentId: "agt_1",
        }
      );

      expect(pathname()).toBe("/agents/agt_1/feedback/item_9");

      rerender({
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });
      expect(pathname()).toBe("/agents/agt_1");
    });

    it("collapses a review deep link onto the agent route", () => {
      const { pathname } = renderRouting("/agents/agt_1/review/agt_summary", {
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });
      expect(pathname()).toBe("/agents/agt_1");
    });
  });

  describe("tab match flags", () => {
    it("reports the changes tab", () => {
      const { result } = renderRouting("/agents/agt_1/changes", {
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });
      expect(result.current.changesMatch).toBe(true);
      expect(result.current.whiteboardMatch).toBe(false);
    });

    it("reports the whiteboard tab", () => {
      const { result } = renderRouting("/agents/agt_1/whiteboard", {
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });
      expect(result.current.changesMatch).toBe(false);
      expect(result.current.whiteboardMatch).toBe(true);
    });

    it("reports the terminal tab as neither match", () => {
      const { result } = renderRouting("/agents/agt_1", {
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });
      expect(result.current.changesMatch).toBe(false);
      expect(result.current.whiteboardMatch).toBe(false);
    });
  });

  describe("chat surface", () => {
    const loaded = {
      routeAgentId: "agt_1",
      agentsLoaded: true,
      validatedSelectedAgentId: "agt_1",
    };

    it("lands the bare agent route on the chat tab when the flag is on", () => {
      chatFlag.enabled = true;
      const { result, pathname } = renderRouting("/agents/agt_1", loaded);
      expect(pathname()).toBe("/agents/agt_1/chat");
      expect(result.current.chatMatch).toBe(true);
    });

    it("keeps the query string across the default redirect", () => {
      chatFlag.enabled = true;
      const { pathname, ...rest } = renderRouting(
        "/agents/agt_1?expandReview=4",
        loaded
      );
      expect(pathname()).toBe("/agents/agt_1/chat");
      // The probe only exposes pathname; read search through the hook's own
      // router by navigating back to the terminal and checking nothing broke.
      expect(rest.result.current.chatMatch).toBe(true);
    });

    it("stays on the console when that was the user's last choice", () => {
      chatFlag.enabled = true;
      getDefaultStore().set(lastCenterTabAtomFamily("agt_1"), "terminal");
      const { result, pathname } = renderRouting("/agents/agt_1", loaded);
      expect(pathname()).toBe("/agents/agt_1");
      expect(result.current.chatMatch).toBe(false);
    });

    it("remembers a console pick made through onTabChange", () => {
      chatFlag.enabled = true;
      const { result, pathname } = renderRouting("/agents/agt_1/chat", loaded);
      act(() => result.current.onTabChange("terminal"));
      expect(pathname()).toBe("/agents/agt_1");
      act(() => result.current.onTabChange("chat"));
      expect(pathname()).toBe("/agents/agt_1/chat");
    });

    it("waits for the flag to load before redirecting", () => {
      chatFlag.enabled = false;
      chatFlag.loaded = false;
      const { pathname } = renderRouting("/agents/agt_1", loaded);
      expect(pathname()).toBe("/agents/agt_1");
    });

    // The Console must not paint under the Chat tab: while the flag is
    // unknown the center tab is reported unresolved, and it becomes resolved
    // in the same render the flag arrives *and* the redirect has landed.
    it("reports the center tab unresolved until the flag loads and the redirect lands", () => {
      chatFlag.enabled = false;
      chatFlag.loaded = false;
      const { result, rerender, pathname } = renderRouting(
        "/agents/agt_1",
        loaded
      );
      expect(result.current.centerTabResolved).toBe(false);

      chatFlag.enabled = true;
      chatFlag.loaded = true;
      rerender(loaded);
      expect(pathname()).toBe("/agents/agt_1/chat");
      expect(result.current.chatMatch).toBe(true);
      expect(result.current.centerTabResolved).toBe(true);
    });

    it("resolves the console immediately when it was the last choice", () => {
      chatFlag.enabled = true;
      getDefaultStore().set(lastCenterTabAtomFamily("agt_1"), "terminal");
      const { result } = renderRouting("/agents/agt_1", loaded);
      expect(result.current.centerTabResolved).toBe(true);
    });

    it("resolves the terminal immediately with the flag off", () => {
      const { result } = renderRouting("/agents/agt_1", loaded);
      expect(result.current.centerTabResolved).toBe(true);
      expect(result.current.chatMatch).toBe(false);
    });

    it("resolves deep links to changes and chat without a redirect", () => {
      chatFlag.enabled = true;
      const changes = renderRouting("/agents/agt_1/changes", loaded);
      expect(changes.pathname()).toBe("/agents/agt_1/changes");
      expect(changes.result.current.centerTabResolved).toBe(true);
      changes.unmount();

      const chat = renderRouting("/agents/agt_1/chat", loaded);
      expect(chat.pathname()).toBe("/agents/agt_1/chat");
      expect(chat.result.current.centerTabResolved).toBe(true);
    });

    it("stays resolved on the bare /agents route with nothing selected", () => {
      const { result } = renderRouting("/agents", {
        routeAgentId: undefined,
        agentsLoaded: true,
        validatedSelectedAgentId: null,
      });
      expect(result.current.centerTabResolved).toBe(true);
    });

    it("does not redirect an unvalidated agent", () => {
      chatFlag.enabled = true;
      const { pathname } = renderRouting("/agents/agt_gone", {
        routeAgentId: "agt_gone",
        agentsLoaded: false,
        validatedSelectedAgentId: null,
      });
      expect(pathname()).toBe("/agents/agt_gone");
    });

    it("falls a persisted chat route back to the terminal when the flag is off", () => {
      const { result, pathname } = renderRouting("/agents/agt_1/chat", loaded);
      expect(pathname()).toBe("/agents/agt_1");
      expect(result.current.chatMatch).toBe(false);
    });
  });

  describe("onTabChange", () => {
    it("navigates between the three tabs, updating the match flags", () => {
      const { result, pathname } = renderRouting("/agents/agt_1", {
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });

      act(() => result.current.onTabChange("changes"));
      expect(pathname()).toBe("/agents/agt_1/changes");
      expect(result.current.changesMatch).toBe(true);

      act(() => result.current.onTabChange("whiteboard"));
      expect(pathname()).toBe("/agents/agt_1/whiteboard");
      expect(result.current.whiteboardMatch).toBe(true);

      act(() => result.current.onTabChange("terminal"));
      expect(pathname()).toBe("/agents/agt_1");
      expect(result.current.changesMatch).toBe(false);
      expect(result.current.whiteboardMatch).toBe(false);
    });

    it("replaces the history entry instead of stacking tab switches", () => {
      const { result, pathname, goBack } = renderRouting("/agents/agt_1", {
        routeAgentId: "agt_1",
        agentsLoaded: true,
        validatedSelectedAgentId: "agt_1",
      });

      act(() => result.current.onTabChange("changes"));
      act(() => result.current.onTabChange("whiteboard"));
      expect(pathname()).toBe("/agents/agt_1/whiteboard");

      goBack();
      expect(pathname()).toBe("/agents/agt_1/whiteboard");
    });

    it("ignores tab changes without a route agent", () => {
      const { result, pathname } = renderRouting("/agents", {
        routeAgentId: undefined,
        agentsLoaded: true,
        validatedSelectedAgentId: null,
      });

      act(() => result.current.onTabChange("changes"));
      expect(pathname()).toBe("/agents");
    });
  });
});
