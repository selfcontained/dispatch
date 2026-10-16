/** Command discovery only: this does not report MCP server connection status. */
export type AgentCommandsResponse = {
  commands: Array<{ name: string; description?: string; inputHint?: string }>;
  /** A live host is attached; an empty command list alone cannot tell us this. */
  connected: boolean;
  mcp: {
    provider: "claude" | "codex" | null;
    /** Requires both a tested provider contract and an advertised /mcp command. */
    available: boolean;
  };
};
