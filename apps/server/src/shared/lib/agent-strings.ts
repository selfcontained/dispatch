export function sanitizeAgentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

/** Shared phrasing for task briefings and the explicit session-name action. */
export const SESSION_RENAME_ASK =
  "call the `rename_session` MCP tool with a short, descriptive name";
