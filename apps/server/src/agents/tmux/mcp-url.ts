import type { AppConfig } from "../../config.js";

/**
 * Build the URL the agent CLI uses to reach Dispatch's MCP endpoint.
 * Standard agents go through `/api/mcp/<agentId>`; job runs use the
 * dedicated `/api/mcp/jobs/<jobRunId>/<agentId>` route.
 */
export function dispatchMcpUrl(
  config: AppConfig,
  agentId: string,
  jobRunId?: string
): string {
  const route = jobRunId
    ? `/api/mcp/jobs/${jobRunId}/${agentId}`
    : `/api/mcp/${agentId}`;
  return `${config.tls ? "https" : "http"}://127.0.0.1:${config.port}${route}`;
}
