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
  /**
   * Types launch_agent will accept. A type switched off in Settings can still
   * have a local usage report, and recommending it sends the agent into a
   * launch that is refused. Absent means every type is launchable.
   */
  enabledAgentTypes?: () => Promise<readonly string[]>;
};

/** Below this much headroom a type is `low`; at none it is `exhausted`. */
const LOW_HEADROOM_PERCENT = 20;

type UsageStatus = "ok" | "low" | "exhausted" | "unknown";

type UsageVerdict = {
  /** The tightest window's remaining percentage; null without a report. */
  headroomPercent: number | null;
  status: UsageStatus;
};

function verdict(windows: Array<{ remainingPercent: number }>): UsageVerdict {
  if (windows.length === 0) return { headroomPercent: null, status: "unknown" };
  const headroomPercent = Math.min(...windows.map((w) => w.remainingPercent));
  const status: UsageStatus =
    headroomPercent <= 0
      ? "exhausted"
      : headroomPercent < LOW_HEADROOM_PERCENT
        ? "low"
        : "ok";
  return { headroomPercent, status };
}

type RatedProvider = UsageVerdict & { type: string; enabled: boolean };

/**
 * Which type to prefer, and why, in one sentence an agent can act on. A
 * suggestion is only made when some reported type is low or exhausted and
 * another has more room: when every report is healthy (or every type is
 * unknown) there is no reason to steer away from the default. Disabled types
 * are described but never suggested — launch_agent would refuse them.
 */
export function summarizeUsage(providers: RatedProvider[]): {
  suggestedType: string | null;
  summary: string;
} {
  const reported = providers.filter(
    (p) => p.enabled && p.headroomPercent !== null
  );
  const strained = reported.filter((p) => p.status !== "ok");
  const describe = (p: RatedProvider) => {
    const headroom =
      p.headroomPercent === null
        ? "unknown"
        : `${p.headroomPercent}% headroom (${p.status})`;
    return `${p.type}: ${headroom}${p.enabled ? "" : ", disabled in settings"}`;
  };
  const detail = providers.map(describe).join("; ");
  if (reported.length === 0) {
    return {
      suggestedType: null,
      summary: `No type reports usage; capacity is unknown. ${detail}.`,
    };
  }
  if (strained.length === 0) {
    return {
      suggestedType: null,
      summary: `Every reported type has headroom; any is fine. ${detail}.`,
    };
  }
  const best = reported.reduce((a, b) =>
    (b.headroomPercent ?? -1) > (a.headroomPercent ?? -1) ? b : a
  );
  if (best.status === "ok") {
    return {
      suggestedType: best.type,
      summary: `Prefer ${best.type}: ${strained.map((p) => `${p.type} is ${p.status}`).join(", ")}. ${detail}.`,
    };
  }
  const unknown = providers.filter(
    (p) => p.enabled && p.headroomPercent === null
  );
  return {
    suggestedType: null,
    summary:
      `Every reported type is low or exhausted` +
      (unknown.length > 0
        ? `; ${unknown.map((p) => p.type).join(", ")} ${unknown.length === 1 ? "does" : "do"} not report usage`
        : "") +
      `. Tell the user before launching. ${detail}.`,
  };
}

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
        "Check remaining subscription usage before launch_agent, so the new agent runs on a type that has headroom. " +
        "Read summary first: it names the type to prefer (also in suggestedType) when another is low or exhausted, " +
        "and says so when every type is fine or nothing reports; a type disabled in Settings (enabled: false) is never suggested. " +
        "Each type carries status (ok, low, exhausted, unknown), " +
        "headroomPercent (its tightest window), supported model ids, the provider's quota windows with remaining percentages and reset times, and observation timestamps. " +
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
        const [report, enabled] = await Promise.all([
          providerPlans({ force }),
          callbacks.enabledAgentTypes?.() ?? CLI_AGENT_TYPES,
        ]);
        const providers = CLI_AGENT_TYPES.filter(
          (engine) => !type || type === engine
        ).map((engine) => {
          const plan = report.providers.find(
            (provider) => provider.engine === engine
          );
          const windows = (plan?.windows ?? []).map((window) => ({
            ...window,
            remainingPercent: Math.max(
              0,
              Math.min(100, 100 - window.usedPercent)
            ),
          }));
          return {
            ...(plan ?? {
              engine,
              plan: null,
              observedAt: null,
              unavailableReason:
                engine === "opencode"
                  ? "OpenCode ACP reports session usage, but does not expose provider subscription limits."
                  : "No usage report available.",
            }),
            type: engine,
            enabled: enabled.includes(engine),
            ...verdict(windows),
            models: getAgentModelOptions(engine),
            windows,
            ...(plan?.spend
              ? {
                  spend: {
                    ...plan.spend,
                    remaining: Math.max(0, plan.spend.limit - plan.spend.used),
                  },
                }
              : {}),
          };
        });
        const result = {
          checkedAt: report.checkedAt,
          ...summarizeUsage(providers),
          providers,
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
