import type { RedeemCodexReset } from "../../agents/codex-reset.js";
import type { ProviderPlan, ProviderPlansResponse } from "@dispatch/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  MAX_WATCHES_PER_AGENT,
  REARM_MARGIN,
  STALE_AFTER_MS,
  USAGE_WATCH_COMPARISONS,
  UsageWatchError,
  describeCondition,
  withRemaining,
  type UsageWatchService,
} from "../../agents/usage-watches.js";
import { getAgentModelOptions } from "../agent-models.js";
import { CLI_AGENT_TYPES } from "../agent-types.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

/** Keep undocumented provider counters out of agent-facing eligibility decisions. */
function agentPlan(plan: ProviderPlan) {
  if (!plan.limitResets) return plan;
  const { applicable: _applicable, ...limitResets } = plan.limitResets;
  return { ...plan, limitResets };
}

export type UsageCallbacks = {
  redeemCodexReset?: RedeemCodexReset;
  providerPlans?: (request?: {
    force?: boolean;
  }) => Promise<ProviderPlansResponse>;
  /**
   * Types launch_agent will accept. A type switched off in Settings can still
   * have a local usage report, and recommending it sends the agent into a
   * launch that is refused. Absent means every type is launchable.
   */
  enabledAgentTypes?: () => Promise<readonly string[]>;
  /** Threshold subscriptions; the tools bind every call to the caller. */
  usageWatches?: Pick<UsageWatchService, "subscribe" | "list" | "unsubscribe">;
};

/** Below this much headroom a type is `low`; at none it is `exhausted`. */
const LOW_HEADROOM_PERCENT = 20;

type UsageStatus = "ok" | "low" | "exhausted" | "unknown";

type UsageVerdict = {
  /** The tightest window's remaining percentage; null without a report. */
  headroomPercent: number | null;
  status: UsageStatus;
};

function verdict(
  plan: ProviderPlan | undefined,
  windows: Array<{ remainingPercent: number }>
): UsageVerdict {
  if (windows.length === 0)
    return {
      headroomPercent: null,
      status: plan?.limitReached === true ? "exhausted" : "unknown",
    };
  const headroomPercent = Math.min(...windows.map((w) => w.remainingPercent));
  const status: UsageStatus =
    plan?.limitReached === true
      ? "exhausted"
      : plan?.limitReached === false &&
          headroomPercent <= 0 &&
          (plan.credits?.unlimited || (plan.credits?.balance ?? 0) > 0)
        ? "low"
        : headroomPercent <= 0
          ? "exhausted"
          : headroomPercent < LOW_HEADROOM_PERCENT
            ? "low"
            : "ok";
  return { headroomPercent, status };
}

type RatedProvider = UsageVerdict & {
  type: string;
  enabled: boolean;
  observedAt?: string | null;
  source?: "live" | "local";
};

function ageLabel(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Which type to prefer, and why, in one sentence an agent can act on. A
 * suggestion is only made when some reported type is low or exhausted and
 * another has more room: when every report is healthy (or every type is
 * unknown) there is no reason to steer away from the default. Disabled types
 * are described but never suggested — launch_agent would refuse them.
 */
export function summarizeUsage(
  providers: RatedProvider[],
  checkedAt?: string
): {
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
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : Date.now();
  const stale = providers.flatMap((provider) => {
    const observedAtMs = provider.observedAt
      ? Date.parse(provider.observedAt)
      : NaN;
    const age = checkedAtMs - observedAtMs;
    return Number.isFinite(age) && age > 15 * 60_000
      ? [
          `${provider.type}'s report is ${ageLabel(age)} old (${provider.source === "local" ? "local report" : "last report"})`,
        ]
      : [];
  });
  const caveat = stale.length ? ` ${stale.join("; ")}.` : "";
  if (reported.length === 0) {
    return {
      suggestedType: null,
      summary: `No type reports usage; capacity is unknown. ${detail}.${caveat}`,
    };
  }
  if (strained.length === 0) {
    return {
      suggestedType: null,
      summary: `Every reported type has headroom; any is fine. ${detail}.${caveat}`,
    };
  }
  // Availability first, then room: a provider whose limit is reached (a
  // spend cap, say) can still show more headroom than one that is open.
  const open = reported.filter((p) => p.status === "ok");
  if (open.length > 0) {
    const best = open.reduce((a, b) =>
      (b.headroomPercent ?? -1) > (a.headroomPercent ?? -1) ? b : a
    );
    return {
      suggestedType: best.type,
      summary: `Prefer ${best.type}: ${strained.map((p) => `${p.type} is ${p.status}`).join(", ")}. ${detail}.${caveat}`,
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
      `. Tell the user before launching. ${detail}.${caveat}`,
  };
}

export function registerUsageTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: UsageCallbacks,
  callerAgentId?: string
): void {
  if (callerAgentId && callbacks.usageWatches)
    registerUsageWatchTools(
      server,
      allowed,
      callbacks.usageWatches,
      callerAgentId
    );
  if (allowed.has("redeem_codex_reset") && callbacks.redeemCodexReset) {
    server.registerTool(
      "redeem_codex_reset",
      {
        description:
          "Explicitly spend at most one account-shared Codex reset credit. Redeeming irreversibly consumes a limited reset and affects every agent using this login. Before invoking, call get_usage, present current usage and available resets to the user, and obtain explicit user authorization for this redemption. If the user already clearly authorized this action (for example, 'use a reset now'), proceed without asking again. Generic permission to keep working is not redemption authorization. This is agent guidance, not a server-enforced approval gate. ChatGPT chooses the oldest eligible credit; no purchase. Reuse the same UUID idempotencyKey for retries; results, including uncertain failures, are retained for ten minutes in this server process. Concurrent distinct requests are refused. Protection is lost on server restart. Never automatically retry an uncertain result with a new key. outcome preserves provider codes (ok, nothing_to_reset, no_credit, or unknown); error reports uncertainty. usage is the refreshed provider state, including reset credits; refreshError does not change the redemption outcome.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          idempotencyKey: z
            .uuid()
            .describe("UUID for this deliberate redemption; reuse on retries."),
        },
      },
      async ({ idempotencyKey }) => {
        try {
          const redemption = await callbacks.redeemCodexReset!(idempotencyKey);
          const result = {
            ...redemption,
            usage: redemption.usage
              ? {
                  ...redemption.usage,
                  providers: redemption.usage.providers.map(agentPlan),
                }
              : null,
          };
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result,
            ...(result.error ? { isError: true } : {}),
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
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
        "headroomPercent (its tightest window), supported model ids, the provider's quota windows with remaining percentages and reset times, observation timestamps, and source (live or local). " +
        "Quotas are shared across agents using the same provider login; model-specific windows are identified by the provider's window id/label. " +
        "Do not assume each model has a separate budget or that remaining percentages represent a token count. " +
        "Reset available counts describe inventory, not guaranteed redemption eligibility; the provider redemption outcome is authoritative. Missing reports mean unknown capacity, not unlimited usage. Reports may be stale; inspect observedAt and unavailableReason.",
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
            "Request a refresh (normally cached for one minute; refreshes are throttled)."
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
          const windows = withRemaining(plan?.windows ?? []);
          return {
            ...(plan
              ? agentPlan(plan)
              : {
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
            ...verdict(plan, windows),
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
          ...summarizeUsage(providers, report.checkedAt),
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

const ok = (result: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: jsonText(result) }],
  structuredContent: result,
});

function watchError(error: unknown) {
  if (error instanceof UsageWatchError)
    return {
      content: [{ type: "text" as const, text: error.message }],
      isError: true,
    };
  return toToolError(error);
}

function registerUsageWatchTools(
  server: McpServer,
  allowed: Set<string>,
  watches: NonNullable<UsageCallbacks["usageWatches"]>,
  agentId: string
): void {
  if (allowed.has("usage_watch"))
    server.registerTool(
      "usage_watch",
      {
        description:
          "Subscribe yourself to a provider's remaining subscription usage reaching a threshold, instead of polling get_usage. " +
          "The value is get_usage's headroomPercent: the tightest quota window's percentage REMAINING (not used). " +
          "comparison at_or_below fires when remaining <= remainingPercent (e.g. 10 = '10% remaining or less'); at_or_above fires when remaining >= remainingPercent (recovery, e.g. after a reset). Equality matches. " +
          "Returns the watch id, the normalized condition, the current reading and matched (true/false, or null when the report is unknown/stale). " +
          "If already matched, this response is that episode's notice: no separate message follows until usage moves " +
          `${REARM_MARGIN} points back past the threshold and returns. ` +
          "Later notices arrive as a USAGE WATCH message in your own session with provider, tightest window, remaining %, reset time and observedAt; one per episode, not per refresh. " +
          `Reports with no windows, no observation time or older than ${STALE_AFTER_MS / 60_000} minutes never match or rearm — unknown is not zero. ` +
          "Reports are read from the shared usage cache, refreshed in the background every few minutes while a watch exists. " +
          "Watches persist across session and server restarts until usage_unwatch or archive; while you are stopped no notice is sent, and one matching on resume is delivered then. A notice that could not be delivered (restart, no live session) is retried while the condition still holds, so a rare duplicate is possible; a missing one is not. " +
          `Subscribing the same condition again returns the existing watch. Up to ${MAX_WATCHES_PER_AGENT} per agent. ` +
          "A notice is information only: it never launches agents, switches providers, notifies the user, redeems resets, spends credits or grants approval.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: z
            .enum(CLI_AGENT_TYPES)
            .describe(
              "Provider/agent type to watch: claude or codex (opencode does not report subscription limits)."
            ),
          comparison: z
            .enum(USAGE_WATCH_COMPARISONS)
            .describe(
              "at_or_below: low-capacity watch. at_or_above: recovery watch."
            ),
          remainingPercent: z
            .number()
            .min(0)
            .max(100)
            .describe(
              "Threshold as percent REMAINING in the tightest window, 0-100."
            ),
        },
      },
      async ({ type, comparison, remainingPercent }) => {
        try {
          const result = await watches.subscribe(agentId, {
            type: type as never,
            comparison,
            remainingPercent,
          });
          return ok({
            ...result,
            condition: describeCondition(comparison, remainingPercent),
          });
        } catch (error) {
          return watchError(error);
        }
      }
    );
  if (allowed.has("usage_watch_list"))
    server.registerTool(
      "usage_watch_list",
      {
        description:
          "List your own usage watches: condition, armed (false = this episode was already reported), last reading applied and last notice time.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: {},
      },
      async () => {
        try {
          return ok({ watches: await watches.list(agentId) });
        } catch (error) {
          return watchError(error);
        }
      }
    );
  if (allowed.has("usage_unwatch"))
    server.registerTool(
      "usage_unwatch",
      {
        description:
          "Remove one of your usage watches by id. Idempotent: removed is false when it was already gone or is not yours. Stops future notices and drops one still queued.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: { id: z.string().min(1).max(64) },
      },
      async ({ id }) => {
        try {
          return ok({ id, removed: await watches.unsubscribe(agentId, id) });
        } catch (error) {
          return watchError(error);
        }
      }
    );
}
