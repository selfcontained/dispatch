import { ArrowLeft, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  formatDuration,
  formatTokenCount,
  shortProjectName,
} from "@/lib/format";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { StatCard } from "@/components/app/stat-card";
import { useHistoryAgentDetail } from "@/hooks/use-agent-history";
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
} from "@/components/app/agent-history-event-types";
import { DetailTabs } from "@/components/app/agent-history-detail-tabs";
import { DurationBar } from "@/components/app/agent-history-duration-bar";

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
  const { data, isLoading, isError } = useHistoryAgentDetail(agentId);

  if (isLoading) {
    return (
      <div className="space-y-4 p-5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-muted/30" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-4 p-5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to history
        </button>
        <div className="flex flex-col items-center justify-center py-16 text-center text-sm text-muted-foreground">
          <Search className="mb-3 h-8 w-8" />
          <div className="font-medium text-foreground">Agent not found</div>
          <div className="mt-1 max-w-xs text-xs">
            No history data exists for this agent ID. It may have been cleaned
            up or the link may be invalid.
          </div>
        </div>
      </div>
    );
  }

  const {
    agent,
    events,
    tokenUsage,
    media,
    feedback,
    messages,
    stateDurations,
  } = data;
  const durationMs =
    new Date(agent.updatedAt).getTime() - new Date(agent.createdAt).getTime();
  const totalTokens =
    tokenUsage.total_input +
    tokenUsage.total_cache_creation +
    tokenUsage.total_cache_read +
    tokenUsage.total_output;

  return (
    <div className="mx-auto max-w-5xl min-w-0 space-y-6 px-3 pt-4 pb-12 sm:space-y-8 sm:px-5 sm:pt-6 sm:pb-20 md:px-8">
      {/* Header */}
      <div>
        <button
          onClick={onBack}
          className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to history
        </button>
        <div className="flex items-center gap-2">
          <AgentTypeIcon type={agent.type} />
          <h2 className="text-base font-semibold text-foreground">
            {agent.name}
          </h2>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {new Date(agent.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}{" "}
            at{" "}
            {new Date(agent.createdAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span>{formatDuration(durationMs)}</span>
        </div>

        {/* Agent details */}
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          {(agent.worktreeBranch || agent.gitContext?.branch) && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px]">Branch</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {agent.worktreeBranch || agent.gitContext?.branch}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[11px]">Project</span>
            <span className="font-mono text-[11px]">
              {shortProjectName(agent.gitContext?.repoRoot ?? agent.cwd)}
            </span>
          </div>
          {agent.gitContext?.worktreePath && agent.gitContext.isWorktree && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px]">Worktree</span>
              <span className="font-mono text-[11px]">
                {shortProjectName(agent.gitContext.worktreePath)}
              </span>
            </div>
          )}
          {agent.cwd !== agent.gitContext?.repoRoot && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px]">Directory</span>
              <span className="font-mono text-[11px]">
                {shortProjectName(agent.cwd)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="flex flex-wrap gap-2 sm:gap-3">
        <StatCard label="Total duration" value={formatDuration(durationMs)} />
        <StatCard
          label="Working"
          value={formatDuration(stateDurations.working ?? 0)}
        />
        <StatCard
          label="Blocked"
          value={formatDuration(stateDurations.blocked ?? 0)}
        />
        <StatCard
          label="Waiting"
          value={formatDuration(stateDurations.waiting_user ?? 0)}
        />
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
      </div>

      {/* Duration bar */}
      {Object.values(stateDurations).some((v) => v > 0) && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-foreground">
            Duration breakdown
          </h3>
          <DurationBar durations={stateDurations} />
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            {["working", "blocked", "waiting_user"].map(
              (key) =>
                (stateDurations[key] ?? 0) > 0 && (
                  <span key={key} className="flex items-center gap-1">
                    <span
                      className={cn(
                        "inline-block h-2 w-2 rounded-full",
                        EVENT_TYPE_COLORS[key]
                      )}
                    />
                    {EVENT_TYPE_LABELS[key]}:{" "}
                    {formatDuration(stateDurations[key])}
                  </span>
                )
            )}
          </div>
        </div>
      )}

      {/* Tabbed: Events / Media / Pins / Feedback / Messages */}
      <DetailTabs
        events={events}
        media={media}
        pins={agent.pins ?? []}
        feedback={feedback}
        messages={messages}
        agentId={agentId}
        workspaceRoot={agent.gitContext?.repoRoot ?? agent.cwd}
      />
    </div>
  );
}
