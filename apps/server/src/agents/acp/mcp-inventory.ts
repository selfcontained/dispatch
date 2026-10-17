import type { McpInventory } from "@dispatch/shared";

/** Project at the process boundary as well as in adapters; reject partial data. */
export function parseMcpInventory(value: unknown): McpInventory {
  if (!value || typeof value !== "object") throw new Error("Invalid inventory");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.servers))
    throw new Error("Invalid inventory");
  return {
    version: 1,
    servers: data.servers.map((raw: unknown) => {
      if (!raw || typeof raw !== "object") throw new Error("Invalid server");
      const server = raw as Record<string, unknown>;
      if (
        typeof server.name !== "string" ||
        typeof server.state !== "string" ||
        !["known", "unknown", "error"].includes(String(server.toolsState))
      )
        throw new Error("Invalid server");
      const toolsState = server.toolsState as "known" | "unknown" | "error";
      if (
        toolsState === "known"
          ? !Array.isArray(server.tools)
          : server.tools !== null
      )
        throw new Error("Invalid tools");
      return {
        name: server.name,
        state: [
          "connected",
          "failed",
          "pending",
          "needs-auth",
          "disabled",
          "starting",
          "notStarted",
          "authenticationRequired",
          "cancelled",
        ].includes(server.state)
          ? server.state
          : "unknown",
        toolsState,
        tools:
          toolsState === "known"
            ? (server.tools as unknown[]).map((rawTool) => {
                if (!rawTool || typeof rawTool !== "object")
                  throw new Error("Invalid tool");
                const tool = rawTool as Record<string, unknown>;
                if (
                  typeof tool.name !== "string" ||
                  (tool.description !== undefined &&
                    typeof tool.description !== "string")
                )
                  throw new Error("Invalid tool");
                return {
                  name: tool.name,
                  ...(typeof tool.description === "string"
                    ? { description: tool.description }
                    : {}),
                };
              })
            : null,
      };
    }),
  };
}
