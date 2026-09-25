import type { ProviderPlansResponse } from "@dispatch/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { getAgentModelOptions } from "../agent-models.js";
import { CLI_AGENT_TYPES } from "../agent-types.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type UsageCallbacks = {
  providerPlans?: (request?: {
    force?: boolean;
  }) => Promise<ProviderPlansResponse>;
};

export function registerUsageTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: UsageCallbacks
): void {
  if (!allowed.has("get_usage") || !callbacks.providerPlans) return;
  const providerPlans = callbacks.providerPlans;
  server.registerTool(
    "get_usage",
    {
      description:
        "Look up remaining subscription usage before choosing a subagent type or model for launch_agent. " +
        "Returns supported model ids, provider-reported quota windows, remaining percentages, reset times, and observation timestamps. " +
        "Quotas are shared across agents using the same provider login; model-specific windows are identified by the provider's window id/label. " +
        "Do not assume each model has a separate budget or that remaining percentages represent a token count. " +
        "Missing reports mean unknown capacity, not unlimited usage. Reports may be stale; inspect observedAt and unavailableReason.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: z
          .enum(CLI_AGENT_TYPES)
          .optional()
          .describe("Filter to an agent type; omit to compare all types."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Request a refresh (normally cached for one minute; refreshes are throttled). Codex reads its latest local usage report."
          ),
      },
    },
    async ({ type, force }) => {
      try {
        const report = await providerPlans({ force });
        const result = {
          checkedAt: report.checkedAt,
          providers: CLI_AGENT_TYPES.filter(
            (engine) => !type || type === engine
          ).map((engine) => {
            const plan = report.providers.find(
              (provider) => provider.engine === engine
            );
            return {
              ...(plan ?? {
                engine,
                plan: null,
                observedAt: null,
                windows: [],
                unavailableReason: "No usage report available.",
              }),
              type: engine,
              models: getAgentModelOptions(engine),
              windows: (plan?.windows ?? []).map((window) => ({
                ...window,
                remainingPercent: Math.max(
                  0,
                  Math.min(100, 100 - window.usedPercent)
                ),
              })),
              ...(plan?.spend
                ? {
                    spend: {
                      ...plan.spend,
                      remaining: Math.max(
                        0,
                        plan.spend.limit - plan.spend.used
                      ),
                    },
                  }
                : {}),
            };
          }),
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
