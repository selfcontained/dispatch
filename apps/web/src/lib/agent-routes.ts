export function agentRoute(agentId: string): string {
  return `/agents/${agentId}`;
}

export function agentChangesRoute(agentId: string): string {
  return `/agents/${agentId}/changes`;
}

export function agentWhiteboardRoute(agentId: string): string {
  return `/agents/${agentId}/whiteboard`;
}

export function agentChatRoute(agentId: string): string {
  return `/agents/${agentId}/chat`;
}
