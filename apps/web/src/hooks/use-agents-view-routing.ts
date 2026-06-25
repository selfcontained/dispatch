import { useCallback, useEffect, useRef, type TransitionEvent } from "react";
import { useMatch, useNavigate } from "react-router-dom";

import { type FeedbackDetailState } from "@/components/app/feedback-utils";
import { type Agent } from "@/components/app/types";
import {
  agentChangesRoute,
  agentFeedbackRoute,
  agentReviewRoute,
  agentRoute,
} from "@/lib/agent-routes";

type UseAgentsViewRoutingOptions = {
  routeAgentId: string | undefined;
  agents: Agent[];
  agentsLoaded: boolean;
  validatedSelectedAgentId: string | null;
};

export function useAgentsViewRouting({
  routeAgentId,
  agents,
  agentsLoaded,
  validatedSelectedAgentId,
}: UseAgentsViewRoutingOptions) {
  const navigate = useNavigate();
  const feedbackMatch = useMatch("/agents/:agentId/feedback/:itemId");
  const reviewMatch = useMatch("/agents/:agentId/review/:summaryAgentId");
  const changesMatch = useMatch("/agents/:agentId/changes");
  const itemId = feedbackMatch?.params.itemId;
  const summaryAgentId = reviewMatch?.params.summaryAgentId;

  const feedbackItemId =
    itemId !== undefined && Number.isInteger(Number(itemId))
      ? Number(itemId)
      : null;
  const feedbackDetail: FeedbackDetailState = routeAgentId
    ? summaryAgentId
      ? { parentAgentId: routeAgentId, summaryAgentId }
      : feedbackItemId !== null
        ? { parentAgentId: routeAgentId, itemId: feedbackItemId }
        : null
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
    if (itemId !== undefined && feedbackItemId === null) {
      navigate(agentRoute(routeAgentId), { replace: true });
    }
  }, [agentsLoaded, feedbackItemId, itemId, navigate, routeAgentId]);

  useEffect(() => {
    if (!routeAgentId || !summaryAgentId) return;
    if (!agentsLoaded) return;
    const summaryAgentExists = agents.some(
      (agent) => agent.id === summaryAgentId
    );
    if (!summaryAgentExists) {
      navigate(agentRoute(routeAgentId), { replace: true });
    }
  }, [agents, agentsLoaded, navigate, routeAgentId, summaryAgentId]);

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

  const openFeedbackDetail = useCallback(
    (state: FeedbackDetailState) => {
      if (!state) {
        closeFeedbackDetail();
        return;
      }
      if ("summaryAgentId" in state) {
        navigate(agentReviewRoute(state.parentAgentId, state.summaryAgentId));
        return;
      }
      navigate(agentFeedbackRoute(state.parentAgentId, state.itemId));
    },
    [closeFeedbackDetail, navigate]
  );

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
    openFeedbackDetail,
    navigateFeedbackItem,
    onTabChange,
  };
}
