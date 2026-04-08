import type { JobTools, McpAgent, McpRequestContext } from "@dispatch/shared/mcp/server.js";

type SharedAgentToolCallbacks = Pick<
  McpRequestContext,
  | "shareMedia"
  | "submitFeedback"
  | "launchPersona"
  | "getFeedback"
  | "resolveFeedback"
  | "upsertPin"
  | "deletePin"
  | "getParentContext"
  | "updateReviewStatus"
  | "completeReview"
>;

type BaseContextArgs = {
  agent: McpAgent;
  repoRoot: string | null;
  worktreeRoot: string | null;
};

export function buildAgentMcpContext(
  args: BaseContextArgs & SharedAgentToolCallbacks & Pick<McpRequestContext, "upsertEvent">
): McpRequestContext {
  return {
    agent: args.agent,
    repoRoot: args.repoRoot,
    worktreeRoot: args.worktreeRoot,
    upsertEvent: args.upsertEvent,
    shareMedia: args.shareMedia,
    submitFeedback: args.submitFeedback,
    launchPersona: args.launchPersona,
    getFeedback: args.getFeedback,
    resolveFeedback: args.resolveFeedback,
    upsertPin: args.upsertPin,
    deletePin: args.deletePin,
    getParentContext: args.getParentContext,
    updateReviewStatus: args.updateReviewStatus,
    completeReview: args.completeReview,
  };
}

export function buildJobMcpContext(
  args: BaseContextArgs & { jobTools: JobTools }
): McpRequestContext {
  return {
    agent: args.agent,
    repoRoot: args.repoRoot,
    worktreeRoot: args.worktreeRoot,
    enableBuiltinTools: false,
    toolScope: "job",
    jobTools: args.jobTools,
  };
}
