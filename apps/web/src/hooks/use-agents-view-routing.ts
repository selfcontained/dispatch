import { useCallback, useEffect } from "react";
import { useMatch, useNavigate } from "react-router-dom";

import {
  agentChangesRoute,
  agentRoute,
  agentWhiteboardRoute,
} from "@/lib/agent-routes";

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
  const feedbackMatch = useMatch("/agents/:agentId/feedback/:itemId");
  const reviewMatch = useMatch("/agents/:agentId/review/:summaryAgentId");
  const changesMatch = useMatch("/agents/:agentId/changes");
  const whiteboardMatch = useMatch("/agents/:agentId/whiteboard");

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

  const onTabChange = useCallback(
    (tab: "terminal" | "changes" | "whiteboard") => {
      if (!routeAgentId) return;
      navigate(
        tab === "changes"
          ? agentChangesRoute(routeAgentId)
          : tab === "whiteboard"
            ? agentWhiteboardRoute(routeAgentId)
            : agentRoute(routeAgentId),
        { replace: true }
      );
    },
    [navigate, routeAgentId]
  );

  return {
    changesMatch: !!changesMatch,
    whiteboardMatch: !!whiteboardMatch,
    onTabChange,
  };
}
