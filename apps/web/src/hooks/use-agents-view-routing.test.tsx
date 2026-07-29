// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Location, NavigateFunction } from "react-router-dom";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { useAgentsViewRouting } from "./use-agents-view-routing";

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
