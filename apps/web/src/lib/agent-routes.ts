export function agentRoute(agentId: string): string {
  return `/agents/${agentId}`;
}

export function agentChangesRoute(agentId: string): string {
  return `/agents/${agentId}/changes`;
}

export function agentFeedbackRoute(agentId: string, itemId: number): string {
  return `/agents/${agentId}/feedback/${itemId}`;
}

export function agentReviewRoute(
  agentId: string,
  reviewAgentId: string
): string {
  return `/agents/${agentId}/review/${reviewAgentId}`;
}
