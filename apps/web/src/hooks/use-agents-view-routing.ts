import { useCallback, useEffect } from "react";
import { useStore } from "jotai";
import { useLocation, useMatch, useNavigate } from "react-router-dom";

import { useChatSurfaceEnabled } from "@/hooks/use-chat-surface-enabled";
import { agentChatRoute, agentRoute } from "@/lib/agent-routes";
import { type CenterTab, centerTabRoute, isCenterTab } from "@/lib/center-tabs";
import { lastCenterTabAtomFamily } from "@/lib/store";

type UseAgentsViewRoutingOptions = {
  routeAgentId: string | undefined;
  agentsLoaded: boolean;
  validatedSelectedAgentId: string | null;
};

export function useAgentsViewRouting({
  routeAgentId,
  agentsLoaded,
  validatedSelectedAgentId,
}: UseAgentsViewRoutingOptions) {
  const navigate = useNavigate();
  const location = useLocation();
  const feedbackMatch = useMatch("/agents/:agentId/feedback/:itemId");
  const reviewMatch = useMatch("/agents/:agentId/review/:summaryAgentId");
  const changesMatch = useMatch("/agents/:agentId/changes");
  const whiteboardMatch = useMatch("/agents/:agentId/whiteboard");
  const chatMatch = useMatch("/agents/:agentId/chat");
  const bareMatch = useMatch("/agents/:agentId");
  const { enabled: chatEnabled, loaded: chatFlagLoaded } =
    useChatSurfaceEnabled();
  // Read synchronously (not subscribed): the value only matters for the
  // redirect decision below, which has to be made during this render.
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

  // Chat is the default tab when the flag is on: the bare agent route lands
  // there unless the user last chose the Console for this agent. With the
  // flag off the chat route has nothing to render, so it falls back to the
  // terminal — that also covers a bookmarked /chat URL after the flag is
  // turned off.
  //
  // The redirect is decided during render (`pendingTabRedirect`) and only
  // performed in the effect below, so the view can hold the center pane on
  // the same commit the redirect is scheduled: nothing paints the Console
  // for a frame while the URL catches up.
  const lastTab = routeAgentId
    ? (() => {
        const stored = store.get(lastCenterTabAtomFamily(routeAgentId));
        return isCenterTab(stored) ? stored : null;
      })()
    : null;
  const wantsChatByDefault =
    !!routeAgentId && !!bareMatch && lastTab !== "terminal";
  const pendingTabRedirect =
    !!routeAgentId &&
    (!chatFlagLoaded || (chatEnabled ? wantsChatByDefault : !!chatMatch));

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded || !validatedSelectedAgentId) return;
    if (!chatFlagLoaded) return;
    if (chatEnabled) {
      if (wantsChatByDefault) {
        navigate(
          { pathname: agentChatRoute(routeAgentId), search: location.search },
          { replace: true }
        );
      }
      return;
    }
    if (chatMatch) {
      navigate(
        { pathname: agentRoute(routeAgentId), search: location.search },
        { replace: true }
      );
    }
  }, [
    agentsLoaded,
    chatEnabled,
    chatFlagLoaded,
    chatMatch,
    location.search,
    navigate,
    routeAgentId,
    validatedSelectedAgentId,
    wantsChatByDefault,
  ]);

  const onTabChange = useCallback(
    (tab: CenterTab) => {
      if (!routeAgentId) return;
      store.set(lastCenterTabAtomFamily(routeAgentId), tab);
      navigate(centerTabRoute(routeAgentId, tab), { replace: true });
    },
    [navigate, routeAgentId, store]
  );

  return {
    changesMatch: !!changesMatch,
    whiteboardMatch: !!whiteboardMatch,
    chatMatch: chatEnabled && !!chatMatch,
    /**
     * False while the tab the route resolves to is still unknown: the flag
     * has not loaded on this browser yet, or the bare/chat route is about to
     * be replaced. The center pane renders nothing tab-specific until this is
     * true, so the Console never shows up underneath the Chat tab.
     */
    centerTabResolved: !pendingTabRedirect,
    onTabChange,
  };
}
