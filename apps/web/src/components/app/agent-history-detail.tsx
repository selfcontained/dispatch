import { useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  formatTokenCount,
  shortProjectName,
} from "@/lib/format";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { StatCard } from "@/components/app/stat-card";
import { MediaLightbox, stripTimestamp } from "@/components/app/media-lightbox";
import { PinItem } from "@/components/app/pins-panel";
import { type AgentPin } from "@/components/app/types";
import {
  useHistoryAgentDetail,
  type HistoryEvent,
  type HistoryFeedbackItem,
  type HistoryMedia,
} from "@/hooks/use-agent-history";
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
  EventTimeline,
  FeedbackTimeline,
} from "@/components/app/agent-history-timeline";

// ── Helpers ─────────────────────────────────────────────────────────

function shortModelName(model: string): string {
  return model.replace(/-\d{8}$/, "").replace("claude-", "");
}

// ── Duration bar ────────────────────────────────────────────────────

const durationChartConfig: ChartConfig = {
  working: { label: "Working", color: "hsl(var(--status-working))" },
  blocked: { label: "Blocked", color: "hsl(var(--status-blocked))" },
  waiting_user: { label: "Waiting", color: "hsl(var(--status-waiting))" },
};

function DurationBar({ durations }: { durations: Record<string, number> }) {
  const total = Object.values(durations).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const data = [
    {
      name: "Duration",
      working: durations.working ?? 0,
      blocked: durations.blocked ?? 0,
      waiting_user: durations.waiting_user ?? 0,
    },
  ];

  return (
    <ChartContainer config={durationChartConfig} className="h-8 w-full">
      <BarChart data={data} layout="vertical" barSize={24}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" hide />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatDuration(Number(value))}
            />
          }
        />
        <Bar
          dataKey="working"
          stackId="a"
          fill="var(--color-working)"
          radius={[4, 0, 0, 4]}
        />
        <Bar dataKey="blocked" stackId="a" fill="var(--color-blocked)" />
        <Bar
          dataKey="waiting_user"
          stackId="a"
          fill="var(--color-waiting_user)"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}

// ── Detail tabs ─────────────────────────────────────────────────────

type DetailTab = "events" | "media" | "pins" | "feedback";

function DetailTabs({
  events,
  media,
  pins,
  feedback,
  agentId,
  workspaceRoot,
}: {
  events: HistoryEvent[];
  media: HistoryMedia[];
  pins: AgentPin[];
  feedback: HistoryFeedbackItem[];
  agentId: string;
  workspaceRoot: string | null;
}) {
  const [tab, setTab] = useState<DetailTab>("events");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const lightboxItems = useMemo(
    () =>
      media.map((m) => ({
        src: `/api/v1/agents/${agentId}/media/${encodeURIComponent(m.file_name)}`,
        caption: m.description ?? stripTimestamp(m.file_name),
        file: {
          name: m.file_name,
          size: m.size_bytes,
          updatedAt: m.created_at,
          source: m.source as "screenshot" | "stream" | "text",
        },
      })),
    [media, agentId]
  );

  const lightboxItem =
    lightboxIndex !== null ? (lightboxItems[lightboxIndex] ?? null) : null;

  const tabs: Array<{ key: DetailTab; label: string; count: number }> = [
    { key: "events", label: "Events", count: events.length },
    { key: "media", label: "Media", count: media.length },
    { key: "pins", label: "Pins", count: pins.length },
    { key: "feedback", label: "Feedback", count: feedback.length },
  ];

  return (
    <>
      <div className="min-w-0">
        <div className="flex items-center gap-1 border-b border-border pb-0">
          {tabs.map(({ key, label, count }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "relative px-3 py-1.5 text-xs font-medium transition-colors",
                tab === key
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              {count > 0 && (
                <span
                  className={cn(
                    "ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium",
                    tab === key
                      ? "bg-foreground/15 text-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {count}
                </span>
              )}
              {tab === key && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 bg-foreground" />
              )}
            </button>
          ))}
        </div>

        <div className="pt-3">
          {tab === "events" && events.length > 0 && (
            <EventTimeline events={events} />
          )}
          {tab === "events" && events.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No events recorded.
            </p>
          )}

          {tab === "media" && media.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {media.map((m, i) => (
                <button
                  key={m.file_name}
                  onClick={() => setLightboxIndex(i)}
                  className="overflow-hidden rounded border border-border bg-muted/20 text-left transition-colors hover:border-foreground/30"
                >
                  {m.source === "screenshot" || m.source === "simulator" ? (
                    <img
                      src={`/api/v1/agents/${agentId}/media/${encodeURIComponent(m.file_name)}`}
                      alt={m.description ?? m.file_name}
                      className="aspect-video w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center text-[10px] text-muted-foreground">
                      {m.source}
                    </div>
                  )}
                  {m.description && (
                    <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                      {m.description}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
          {tab === "media" && media.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No media captured.
            </p>
          )}

          {tab === "pins" && pins.length > 0 && (
            <div className="divide-y divide-border rounded-md border border-border">
              {pins.map((pin) => (
                <PinItem
                  key={pin.label.toLowerCase()}
                  pin={pin}
                  workspaceRoot={workspaceRoot}
                />
              ))}
            </div>
          )}
          {tab === "pins" && pins.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No pins recorded.
            </p>
          )}

          {tab === "feedback" && feedback.length > 0 && (
            <FeedbackTimeline feedback={feedback} />
          )}
          {tab === "feedback" && feedback.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No feedback received.
            </p>
          )}
        </div>
      </div>

      <MediaLightbox
        item={lightboxItem}
        currentIndex={lightboxIndex ?? 0}
        totalItems={lightboxItems.length}
        setLightboxIndex={setLightboxIndex}
      />
    </>
  );
}

// ── Agent history detail ────────────────────────────────────────────

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

  const { agent, events, tokenUsage, media, feedback, stateDurations } = data;
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

      {/* Tabbed: Events / Media / Pins / Feedback */}
      <DetailTabs
        events={events}
        media={media}
        pins={agent.pins ?? []}
        feedback={feedback}
        agentId={agentId}
        workspaceRoot={agent.gitContext?.repoRoot ?? agent.cwd}
      />
    </div>
  );
}
