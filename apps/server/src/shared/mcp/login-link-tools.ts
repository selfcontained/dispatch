import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { LOGIN_LINK_TTL_MS } from "../../auth.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

const LOGIN_LINK_EXPIRES_IN_SECONDS = Math.floor(LOGIN_LINK_TTL_MS / 1000);

export type LoginLinkToolsContext = {
  issueLoginLink?: () => string | Promise<string>;
};

export function registerLoginLinkTools(
  server: McpServer,
  allowed: Set<string>,
  context: LoginLinkToolsContext
): void {
  if (!allowed.has("dispatch_login_link") || !context.issueLoginLink) return;

  const issueLoginLink = context.issueLoginLink;
  server.registerTool(
    "dispatch_login_link",
    {
      description: `Create a short-lived, single-use browser login link for the full Dispatch account. The link expires after ${LOGIN_LINK_EXPIRES_IN_SECONDS} seconds. Open the returned path on the Dispatch server origin.`,
      inputSchema: {},
    },
    async () => {
      try {
        const token = await issueLoginLink();
        const result = {
          token,
          path: `/login#login-link=${token}`,
          expiresInSeconds: LOGIN_LINK_EXPIRES_IN_SECONDS,
        };
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}
