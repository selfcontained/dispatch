import { useCallback, useEffect, useRef, type TransitionEvent } from "react";
import { useMatch, useNavigate } from "react-router-dom";

import { type FeedbackDetailState } from "@/components/app/feedback-utils";
import {
  agentChangesRoute,
  agentFeedbackRoute,
  agentRoute,
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
  const itemId = feedbackMatch?.params.itemId;
  const feedbackItemId =
    itemId !== undefined && Number.isInteger(Number(itemId))
      ? Number(itemId)
      : null;
  const feedbackDetail: FeedbackDetailState =
    routeAgentId && feedbackItemId !== null
      ? { parentAgentId: routeAgentId, itemId: feedbackItemId }
      : null;
  const feedbackDetailStaleRef =
    useRef<NonNullable<FeedbackDetailState> | null>(null);
  if (feedbackDetail) feedbackDetailStaleRef.current = feedbackDetail;
  const feedbackDetailRendered =
    feedbackDetail ?? feedbackDetailStaleRef.current;

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (validatedSelectedAgentId) return;
    navigate("/agents", { replace: true });
  }, [agentsLoaded, navigate, routeAgentId, validatedSelectedAgentId]);

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (reviewMatch || (itemId !== undefined && feedbackItemId === null)) {
      navigate(agentRoute(routeAgentId), { replace: true });
    }
  }, [
    agentsLoaded,
    feedbackItemId,
    itemId,
    navigate,
    reviewMatch,
    routeAgentId,
  ]);

  const onTabChange = useCallback(
    (tab: "terminal" | "changes") => {
      if (!routeAgentId) return;
      navigate(
        tab === "changes"
          ? agentChangesRoute(routeAgentId)
          : agentRoute(routeAgentId),
        { replace: true }
      );
    },
    [navigate, routeAgentId]
  );

  const closeFeedbackDetail = useCallback(() => {
    if (validatedSelectedAgentId) {
      navigate(agentRoute(validatedSelectedAgentId), { replace: true });
      return;
    }
    navigate("/agents", { replace: true });
  }, [navigate, validatedSelectedAgentId]);

  const navigateFeedbackItem = useCallback(
    (parentAgentId: string, nextItemId: number) => {
      navigate(agentFeedbackRoute(parentAgentId, nextItemId));
    },
    [navigate]
  );

  const hasFeedbackDetail = !!feedbackDetail;
  const handleFeedbackTransitionEnd = useCallback(
    (e: TransitionEvent) => {
      if (e.propertyName === "grid-template-rows" && !hasFeedbackDetail) {
        feedbackDetailStaleRef.current = null;
      }
    },
    [hasFeedbackDetail]
  );

  return {
    changesMatch: !!changesMatch,
    feedbackDetail,
    feedbackDetailRendered,
    handleFeedbackTransitionEnd,
    closeFeedbackDetail,
    navigateFeedbackItem,
    onTabChange,
  };
}
