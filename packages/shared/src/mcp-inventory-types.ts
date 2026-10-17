/** Only read-only public metadata. No connection configuration or native errors. */
export type McpTool = { name: string; description?: string };
export type McpServer = {
  name: string;
  state: string;
  toolsState: "known" | "unknown" | "error";
  tools: McpTool[] | null;
};
export type McpInventory = { version: 1; servers: McpServer[] };
export type AgentMcpInventoryResponse = {
  agentId: string;
  status: "ok" | "offline" | "unsupported" | "timeout" | "unavailable";
  inventory: McpInventory | null;
};
