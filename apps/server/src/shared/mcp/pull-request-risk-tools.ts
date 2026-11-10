import type { AgentPullRequest, MergeRiskSummary } from "@dispatch/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { githubPullRequestUrl } from "../../agents/pull-request-reader.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type RiskReader = (input: {
  agentId: string;
  url: string;
}) => Promise<unknown>;

/** Only accepts cached display summaries, never provider records or prompts. */
function assessment(risk: MergeRiskSummary | undefined) {
  if (!risk?.assessedAt) return null;
  return {
    headSha: risk.headSha,
    assessedAt: risk.assessedAt,
    promptVersion: risk.promptVersion,
    status: risk.status,
    verdict: risk.verdict,
    confidence: risk.confidence,
    changeRisk: risk.changeRisk,
    changeRiskLabel: risk.changeRiskLabel,
    reviewAdequate: risk.reviewAdequate,
    descriptionMatches: risk.descriptionMatches,
    newSurface: risk.newSurface,
    routineProbability: risk.routineProbability,
    humanReviewProbability: risk.humanReviewProbability,
  };
}

export function createRiskReader(deps: {
  caller: { id: string; projectId?: string | null };
  getAgent: (id: string) => Promise<{ projectId?: string | null } | null>;
  visibleAgents: () => Promise<{ id: string }[]>;
  inventory?: { get: (id: string) => AgentPullRequest[] };
  enabled?: () => Promise<boolean>;
}): RiskReader {
  return async ({ agentId, url }) => {
    const target = await deps.getAgent(agentId);
    if (
      !target ||
      (agentId !== deps.caller.id &&
        (!deps.caller.projectId ||
          target.projectId !== deps.caller.projectId ||
          !(await deps.visibleAgents()).some((agent) => agent.id === agentId)))
    )
      throw new Error("Agent not found or outside authorized scope.");
    const canonical = githubPullRequestUrl(url);
    if (!canonical)
      throw new Error("Expected an HTTPS github.com pull request URL.");
    if (!deps.inventory) throw new Error("PR tracking unavailable.");
    const pr = deps.inventory
      .get(agentId)
      .find((item) => githubPullRequestUrl(item.url) === canonical);
    if (!pr) throw new Error("PR not found in this agent's cached inventory.");
    const enabled = deps.enabled ? await deps.enabled() : true;
    const risk = enabled ? pr.mergeRisk : undefined;
    const headSha = pr.ci?.headSha || null;
    const candidate = assessment(risk);
    const current =
      !risk?.displayState &&
      (pr.status === "Open" || pr.status === "Draft") &&
      headSha &&
      candidate?.headSha === headSha
        ? candidate
        : null;
    return {
      agentId,
      url: canonical,
      source: "cached_inventory",
      lifecycle: pr.status,
      headSha,
      checkedAt: pr.ci?.checkedAt ?? null,
      ci: pr.ci
        ? { availability: pr.ci.availability, summary: pr.ci.summary }
        : null,
      state: !enabled
        ? "disabled"
        : (risk?.displayState ??
          (current
            ? current.verdict === "abstain"
              ? "inconclusive"
              : "current"
            : candidate
              ? "stale"
              : "absent")),
      currentAssessment: current,
      priorAssessment: current
        ? null
        : (candidate ?? assessment(risk?.previous)),
      mergeApproval: false,
    };
  };
}

export function registerPullRequestRiskTool(
  server: McpServer,
  allowed: Set<string>,
  read?: RiskReader
) {
  if (!read || !allowed.has("get_pull_request_risk")) return;
  server.registerTool(
    "get_pull_request_risk",
    {
      description:
        "Read one already-computed PR risk from cached inventory. Requires explicit agentId and GitHub PR URL in your authorized project/repo scope. Returns cached head/check time, lifecycle, display state, exact-head assessment and separately labeled prior history. No refresh or paid assessment; cached head may lag GitHub. Absent is not pending, stale/history is never current, and no result grants merge approval. Unknown/out-of-scope agents and unknown PRs return errors. Rationale is limited to available display metrics; private reviews and provider prompts are excluded.",
      inputSchema: {
        agentId: z.string().min(1).max(256),
        url: z.string().min(1).max(4096),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return {
          content: [
            { type: "text" as const, text: jsonText(await read(input)) },
          ],
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}
