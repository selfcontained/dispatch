import { useCallback, useEffect } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";

import { useChatSurfaceEnabled } from "@/hooks/use-chat-surface-enabled";
import {
  agentChangesRoute,
  agentChatRoute,
  agentRoute,
  agentWhiteboardRoute,
} from "@/lib/agent-routes";
import { readLastCenterTab, rememberCenterTab } from "@/lib/center-tab-memory";
import { type CenterTab } from "@/lib/store";

type UseAgentsViewRoutingOptions = {
  routeAgentId: string | undefined;
  agentsLoaded: boolean;
  validatedSelectedAgentId: string | null;
};

export function centerTabRoute(agentId: string, tab: CenterTab): string {
  switch (tab) {
    case "chat":
      return agentChatRoute(agentId);
    case "changes":
      return agentChangesRoute(agentId);
    case "whiteboard":
      return agentWhiteboardRoute(agentId);
    default:
      return agentRoute(agentId);
  }
}

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
  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded || !validatedSelectedAgentId) return;
    if (!chatFlagLoaded) return;
    if (chatEnabled) {
      if (bareMatch && readLastCenterTab(routeAgentId) !== "terminal") {
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
    bareMatch,
    chatEnabled,
    chatFlagLoaded,
    chatMatch,
    location.search,
    navigate,
    routeAgentId,
    validatedSelectedAgentId,
  ]);

  const onTabChange = useCallback(
    (tab: CenterTab) => {
      if (!routeAgentId) return;
      rememberCenterTab(routeAgentId, tab);
      navigate(centerTabRoute(routeAgentId, tab), { replace: true });
    },
    [navigate, routeAgentId]
  );

  return {
    changesMatch: !!changesMatch,
    whiteboardMatch: !!whiteboardMatch,
    chatMatch: chatEnabled && !!chatMatch,
    onTabChange,
  };
}
