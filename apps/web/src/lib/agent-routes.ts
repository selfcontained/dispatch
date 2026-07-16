export function agentRoute(agentId: string): string {
  return `/agents/${agentId}`;
}

export function agentChangesRoute(agentId: string): string {
  return `/agents/${agentId}/changes`;
}
