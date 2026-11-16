import { useProjectNavigate } from "@/hooks/use-projects";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useMatch } from "react-router-dom";

import {
  AGENT_LEFT_STATE,
  agentHistoryRoute,
  agentRoute,
} from "@/lib/agent-routes";
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
  const navigate = useProjectNavigate();
  const location = useLocation();
  const feedbackMatch = useMatch("/agents/:agentId/feedback/:itemId");
  const reviewMatch = useMatch("/agents/:agentId/review/:summaryAgentId");
  const changesMatch = useMatch("/agents/:agentId/changes");
  const filesMatch = useMatch("/agents/:agentId/files");
  const chatMatch = useMatch("/agents/:agentId/chat");

  // The agent this route showed live. It outlives validation for one step so
  // the view can tell "the agent on screen was just archived" (stay in
  // Agents) from "a link named an archived agent" (open it in history).
  const [liveAgentId, setLiveAgentId] = useState<string | null>(null);
  const currentLiveAgentId =
    validatedSelectedAgentId ??
    (routeAgentId && routeAgentId === liveAgentId ? liveAgentId : null);
  if (currentLiveAgentId !== liveAgentId) setLiveAgentId(currentLiveAgentId);
  const viewedAgentLeft =
    !!routeAgentId &&
    agentsLoaded &&
    !validatedSelectedAgentId &&
    liveAgentId === routeAgentId;

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (validatedSelectedAgentId) return;
    if (viewedAgentLeft) {
      navigate("/agents", {
        replace: true,
        state: { [AGENT_LEFT_STATE]: true },
      });
      return;
    }
    // A missing live seat may be archived; preserve its conversation anchor.
    navigate(
      { pathname: agentHistoryRoute(routeAgentId), search: location.search },
      { replace: true }
    );
  }, [
    agentsLoaded,
    location.search,
    navigate,
    routeAgentId,
    validatedSelectedAgentId,
    viewedAgentLeft,
  ]);

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
    filesMatch: !!filesMatch,
    /**
     * False while a legacy /chat route is about to be replaced. The center
     * pane renders nothing tab-specific until this is true.
     */
    centerTabResolved: !pendingTabRedirect,
    /**
     * The agent on screen just left the live list (archived). The view keeps
     * its menus as they are while the route moves to `/agents`.
     */
    viewedAgentLeft: viewedAgentLeft || !!location.state?.[AGENT_LEFT_STATE],
    onTabChange,
  };
}
