import { useCallback, useEffect } from "react";
import { useStore } from "jotai";
import { useLocation, useMatch, useNavigate } from "react-router-dom";

import { useChatSurfaceEnabled } from "@/hooks/use-chat-surface-enabled";
import { agentRoute } from "@/lib/agent-routes";
import {
  type CenterTab,
  agentSupportsChat,
  agentSupportsHarness,
  centerTabRoute,
} from "@/lib/center-tabs";
import { agentPaneViewAtomFamily } from "@/lib/store";

type UseAgentsViewRoutingOptions = {
  routeAgentId: string | undefined;
  agentsLoaded: boolean;
  validatedSelectedAgentId: string | null;
  /**
   * The type of the agent the route names, once known. A terminal session
   * has no Chat view, so an old /chat link lands on its Console.
   */
  routeAgentType?: string | null;
};

export function useAgentsViewRouting({
  routeAgentId,
  agentsLoaded,
  validatedSelectedAgentId,
  routeAgentType,
}: UseAgentsViewRoutingOptions) {
  const navigate = useNavigate();
  const location = useLocation();
  const feedbackMatch = useMatch("/agents/:agentId/feedback/:itemId");
  const reviewMatch = useMatch("/agents/:agentId/review/:summaryAgentId");
  const changesMatch = useMatch("/agents/:agentId/changes");
  const whiteboardMatch = useMatch("/agents/:agentId/whiteboard");
  const chatMatch = useMatch("/agents/:agentId/chat");
  const { enabled: chatEnabled, loaded: chatFlagLoaded } =
    useChatSurfaceEnabled();
  // Written synchronously (not subscribed): the view is the Agent pane's
  // business; this hook only flips it when an old /chat link comes in.
  const store = useStore();

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (validatedSelectedAgentId) return;
    navigate("/agents", { replace: true });
  }, [agentsLoaded, navigate, routeAgentId, validatedSelectedAgentId]);

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (reviewMatch || feedbackMatch) {
      navigate(agentRoute(routeAgentId), { replace: true });
    }
  }, [agentsLoaded, feedbackMatch, navigate, reviewMatch, routeAgentId]);

  // `/agents/:id/chat` was the Chat tab's own route in round 1. The Chat
  // view now lives inside the Agent tab at the bare agent route, so an old
  // link (or bookmark) lands there with the view set to Chat. With the flag
  // off — or for a terminal session, which has no Chat view — the route has
  // nothing to render and falls back to the terminal.
  //
  // The redirect is decided during render (`pendingTabRedirect`) and only
  // performed in the effect below, so the view can hold the center pane on
  // the same commit the redirect is scheduled: nothing paints the Console
  // for a frame while the URL catches up.
  const pendingTabRedirect = !!routeAgentId && (!chatFlagLoaded || !!chatMatch);

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded || !validatedSelectedAgentId) return;
    if (!chatFlagLoaded) return;
    if (!chatMatch) return;
    if (chatEnabled && agentSupportsChat(routeAgentType)) {
      store.set(
        agentPaneViewAtomFamily(routeAgentId),
        agentSupportsHarness(routeAgentType) ? "harness" : "chat"
      );
    }
    navigate(
      { pathname: agentRoute(routeAgentId), search: location.search },
      { replace: true }
    );
  }, [
    agentsLoaded,
    chatEnabled,
    chatFlagLoaded,
    chatMatch,
    location.search,
    navigate,
    routeAgentId,
    routeAgentType,
    store,
    validatedSelectedAgentId,
  ]);

  const onTabChange = useCallback(
    (tab: CenterTab) => {
      if (!routeAgentId) return;
      navigate(centerTabRoute(routeAgentId, tab), { replace: true });
    },
    [navigate, routeAgentId]
  );

  return {
    changesMatch: !!changesMatch,
    whiteboardMatch: !!whiteboardMatch,
    /**
     * False while the tab the route resolves to is still unknown: the flag
     * has not loaded on this browser yet, or a legacy /chat route is about
     * to be replaced. The center pane renders nothing tab-specific until this
     * is true, so the Console never shows up under the Chat view.
     */
    centerTabResolved: !pendingTabRedirect,
    onTabChange,
  };
}
