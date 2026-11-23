import { ArchivedConversation } from "./archived-conversation";
import { AgentSessionLink } from "./agent-session-link";
import { ArrowLeft, Search } from "lucide-react";

import {
  formatDateTime,
  formatDuration,
  formatTokenCount,
  shortProjectName,
} from "@/lib/format";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { StatGrid } from "@/components/ui/dashboard";
import { StatCard } from "@/components/app/stat-card";
import {
  useHistoryAgentDetail,
  type HistoryAgentDetail,
} from "@/hooks/use-agent-history";
import { DetailTabs } from "@/components/app/agent-history-detail-tabs";
import { Button } from "@/components/ui/button";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton, Skeleton } from "@/components/ui/skeleton";

function shortModelName(model: string): string {
  return model.replace(/-\d{8}$/, "").replace("claude-", "");
}

export function AgentHistoryDetail({
  agentId,
  onBack,
}: {
  agentId: string;
  onBack: () => void;
}) {
  const query = useHistoryAgentDetail(agentId);

  return (
    <div className="min-w-0">
      <Button variant="ghost" size="xs" onClick={onBack} className="mb-3 -ml-2">
        <ArrowLeft />
        Back to history
      </Button>
      <AsyncBoundary
        query={query}
        thing="the agent’s history"
        loading={
          <LoadingSkeleton
            label="Loading the agent’s history…"
            className="space-y-4"
          >
            <Skeleton className="h-6 w-2/3 max-w-xs" />
            <Skeleton className="h-16" />
            <Skeleton className="h-64" />
          </LoadingSkeleton>
        }
        notFound={
          <EmptyState
            icon={Search}
            title="Agent not found"
            description="No history data exists for this agent ID. It may have been cleaned up or the link may be invalid."
          />
        }
      >
        {(data) => <HistoryDetail agentId={agentId} data={data} />}
      </AsyncBoundary>
    </div>
  );
}

function HistoryDetail({
  agentId,
  data,
}: {
  agentId: string;
  data: HistoryAgentDetail;
}) {
  const { agent, tokenUsage, files } = data;
  const durationMs =
    new Date(agent.updatedAt).getTime() - new Date(agent.createdAt).getTime();
  const totalTokens =
    tokenUsage.total_input +
    tokenUsage.total_cache_creation +
    tokenUsage.total_cache_read +
    tokenUsage.total_output;

  return (
    <div className="min-w-0 space-y-6 sm:space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <AgentSessionLink agentId={agent.id} name={agent.name}>
            <AgentTypeIcon type={agent.type} />
          </AgentSessionLink>
          <h2 className="min-w-0 truncate text-heading-md text-foreground">
            <AgentSessionLink agentId={agent.id} name={agent.name} />
          </h2>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-muted-foreground">
          <span>{formatDateTime(agent.createdAt)}</span>
          <span>{formatDuration(durationMs)}</span>
        </div>

        {/* Agent details */}
        <div className="mt-3 space-y-1 text-body-sm text-muted-foreground">
          {(agent.worktreeBranch || agent.gitContext?.branch) && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-label-sm">Branch</span>
              <span className="min-w-0 break-all rounded-sm bg-muted px-1.5 py-0.5 font-mono text-label-sm text-foreground">
                {agent.worktreeBranch || agent.gitContext?.branch}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-label-sm">Project</span>
            <span className="min-w-0 break-all font-mono text-label-sm">
              {shortProjectName(agent.gitContext?.repoRoot ?? agent.cwd)}
            </span>
          </div>
          {agent.gitContext?.worktreePath && agent.gitContext.isWorktree && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-label-sm">Worktree</span>
              <span className="min-w-0 break-all font-mono text-label-sm">
                {shortProjectName(agent.gitContext.worktreePath)}
              </span>
            </div>
          )}
          {agent.cwd !== agent.gitContext?.repoRoot && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-label-sm">Directory</span>
              <span className="min-w-0 break-all font-mono text-label-sm">
                {shortProjectName(agent.cwd)}
              </span>
            </div>
          )}
        </div>
      </div>

      <ArchivedConversation
        agentId={agentId}
        name={agent.name}
        type={agent.type}
      />

      {/* Stats */}
      <StatGrid>
        <StatCard label="Total duration" value={formatDuration(durationMs)} />
        {totalTokens > 0 && (
          <StatCard
            label="Tokens"
            value={formatTokenCount(totalTokens)}
            sub={
              tokenUsage.by_model.length === 1
                ? `${formatTokenCount(tokenUsage.total_output)} out · ${shortModelName(tokenUsage.by_model[0].model)}`
                : tokenUsage.by_model.length > 1
                  ? `${formatTokenCount(tokenUsage.total_output)} out · ${tokenUsage.by_model.length} models`
                  : `${formatTokenCount(tokenUsage.total_output)} output`
            }
          />
        )}
        {tokenUsage.total_messages > 0 && (
          <StatCard label="Messages" value={tokenUsage.total_messages} />
        )}
      </StatGrid>

      <DetailTabs files={files} agentId={agentId} />
    </div>
  );
}
