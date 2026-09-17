import { useCallback, useEffect } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";

import { agentRoute } from "@/lib/agent-routes";
import { type CenterTab, centerTabRoute } from "@/lib/center-tabs";

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

  // `/agents/:id/chat` was the Chat tab's own route in round 1. Chat is the
  // Agent tab at the bare agent route now, so an old link (or bookmark)
  // lands there. The redirect is decided during render
  // (`pendingTabRedirect`) so the view can hold the center pane on the same
  // commit the redirect is scheduled.
  const pendingTabRedirect = !!routeAgentId && !!chatMatch;

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded || !validatedSelectedAgentId) return;
    if (!chatMatch) return;
    navigate(
      { pathname: agentRoute(routeAgentId), search: location.search },
      { replace: true }
    );
  }, [
    agentsLoaded,
    chatMatch,
    location.search,
    navigate,
    routeAgentId,
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
     * False while a legacy /chat route is about to be replaced. The center
     * pane renders nothing tab-specific until this is true.
     */
    centerTabResolved: !pendingTabRedirect,
    onTabChange,
  };
}
