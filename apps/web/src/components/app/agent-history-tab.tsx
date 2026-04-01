import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { formatDuration, formatTokenCount, formatRelativeTime, shortProjectName } from "@/lib/format";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { StatCard } from "@/components/app/stat-card";
import { MediaLightbox, stripTimestamp } from "@/components/app/media-lightbox";
import {
  useHistoryAgents,
  useHistoryAgentDetail,
  useHistoryProjects,
  type HistoryFilters,
  type HistoryEvent,
  type HistoryMedia,
} from "@/hooks/use-agent-history";
import {
  ACTIVITY_RANGES,
  rangeLabel,
  type ActivityRange,
} from "@/hooks/use-activity";

// ── Helpers ──────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortModelName(model: string): string {
  return model
    .replace(/-\d{8}$/, "")
    .replace("claude-", "");
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  working: "bg-status-working",
  blocked: "bg-status-blocked",
  waiting_user: "bg-status-waiting",
  done: "bg-status-done",
  idle: "bg-muted-foreground",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  working: "Working",
  blocked: "Blocked",
  waiting_user: "Waiting",
  done: "Done",
  idle: "Idle",
};

// ── List View ────────────────────────────────────────────────────────

type SortKey = "created_at" | "name" | "updated_at";

function AgentHistoryList({
  onSelect,
  range,
  onRangeChange,
}: {
  onSelect: (id: string) => void;
  range: ActivityRange;
  onRangeChange: (r: ActivityRange) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [type, setType] = useState("");
  const [project, setProject] = useState("");
  const [sort, setSort] = useState<SortKey>("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const filters: HistoryFilters = useMemo(
    () => ({ search: debouncedSearch, type, project, range, sort, order, offset: 0 }),
    [debouncedSearch, type, project, range, sort, order]
  );

  const { data, isLoading } = useHistoryAgents(filters);
  const { data: projects } = useHistoryProjects();

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sort === key) {
        setOrder((o) => (o === "desc" ? "asc" : "desc"));
      } else {
        setSort(key);
        setOrder("desc");
      }
    },
    [sort]
  );

  const hasActiveFilters = debouncedSearch || type || project || range !== "all";

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-3 sm:px-5 md:px-8">
      {/* Search + filters */}
      <div className="space-y-2 pt-4 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={type || "__all__"} onValueChange={(v) => setType(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-7 w-[100px] text-[11px]">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All types</SelectItem>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
            </SelectContent>
          </Select>

          {projects && projects.length > 0 && (
            <Select value={project || "__all__"} onValueChange={(v) => setProject(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-7 max-w-[180px] text-[11px]">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p} value={p}>
                    {shortProjectName(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={range} onValueChange={(v) => onRangeChange(v as ActivityRange)}>
            <SelectTrigger className="h-7 w-[120px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {rangeLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <button
              onClick={() => {
                setSearch("");
                setType("");
                setProject("");
                onRangeChange("all");
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear filters
            </button>
          )}

          {data && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              {data.total} agent{data.total !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
              <th
                className="cursor-pointer px-3 py-2 font-medium sm:px-5"
                onClick={() => toggleSort("name")}
              >
                Name {sort === "name" && (order === "desc" ? <ChevronDown className="ml-0.5 inline h-3 w-3" /> : <ChevronUp className="ml-0.5 inline h-3 w-3" />)}
              </th>
              <th className="hidden px-2 py-2 font-medium sm:table-cell">Project</th>
              <th className="px-2 py-2 font-medium">Duration</th>
              <th className="px-2 py-2 font-medium">Tokens</th>
              <th
                className="cursor-pointer px-2 py-2 pr-3 font-medium sm:pr-5"
                onClick={() => toggleSort("created_at")}
              >
                Created {sort === "created_at" && (order === "desc" ? <ChevronDown className="ml-0.5 inline h-3 w-3" /> : <ChevronUp className="ml-0.5 inline h-3 w-3" />)}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="px-3 py-2.5 sm:px-5" colSpan={5}>
                    <div className="h-4 w-full animate-pulse rounded bg-muted/30" />
                  </td>
                </tr>
              ))}

            {data?.agents.map((agent) => (
              <tr
                key={agent.id}
                className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
                onClick={() => onSelect(agent.id)}
              >
                <td className="px-3 py-2.5 sm:px-5">
                  <div className="flex items-center gap-2">
                    <AgentTypeIcon type={agent.type} />
                    <span className="truncate font-medium text-foreground">
                      {agent.name}
                    </span>
                  </div>
                </td>
                <td className="hidden px-2 py-2.5 text-muted-foreground sm:table-cell">
                  <span className="truncate" title={agent.gitContext?.repoRoot ?? agent.cwd}>
                    {shortProjectName(agent.gitContext?.repoRoot ?? agent.cwd)}
                  </span>
                </td>
                <td className="px-2 py-2.5 text-muted-foreground">
                  {formatDuration(agent.durationMs)}
                </td>
                <td className="px-2 py-2.5 text-muted-foreground">
                  {agent.totalTokens > 0 ? formatTokenCount(agent.totalTokens) : "—"}
                </td>
                <td className="px-2 py-2.5 pr-3 text-muted-foreground sm:pr-5">
                  {formatRelativeTime(agent.createdAt)}
                </td>
              </tr>
            ))}

            {data && data.agents.length === 0 && !isLoading && (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-12 text-center text-sm text-muted-foreground"
                >
                  No agents found.{" "}
                  {hasActiveFilters && (
                    <span>Try adjusting your filters.</span>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {data && data.agents.length < data.total && (
          <div className="py-3 text-center">
            <button className="text-xs text-muted-foreground hover:text-foreground">
              Showing {data.agents.length} of {data.total} — load more coming soon
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail View ──────────────────────────────────────────────────────

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
        <Bar dataKey="working" stackId="a" fill="var(--color-working)" radius={[4, 0, 0, 4]} />
        <Bar dataKey="blocked" stackId="a" fill="var(--color-blocked)" />
        <Bar dataKey="waiting_user" stackId="a" fill="var(--color-waiting_user)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function EventTimeline({ events }: { events: HistoryEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || events.length <= 10;
  const visible = showAll ? events : [...events.slice(0, 5), ...events.slice(-5)];
  const hiddenCount = events.length - 10;

  return (
    <div className="relative">
      <div className="space-y-0">
        {visible.map((event, i) => {
          const isGap = !showAll && i === 5;
          return (
            <Fragment key={event.id}>
              {isGap && (
                <button
                  onClick={() => setExpanded(true)}
                  className="ml-[7px] flex items-center gap-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <span className="h-px w-3 bg-border" />
                  {hiddenCount} more event{hiddenCount !== 1 ? "s" : ""}
                </button>
              )}
              <div className="group flex items-start gap-3 py-1">
                <div className="flex flex-col items-center pt-1.5">
                  <div
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      EVENT_TYPE_COLORS[event.event_type] ?? "bg-muted-foreground"
                    )}
                  />
                  {i < visible.length - 1 && (
                    <div className="mt-0.5 w-px flex-1 bg-border" />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {formatTimestamp(event.created_at)}
                    </span>
                    <span
                      className={cn(
                        "inline-block rounded px-1 py-0.5 text-[10px] font-medium",
                        event.event_type === "working" && "bg-status-working/15 text-status-working",
                        event.event_type === "blocked" && "bg-status-blocked/15 text-status-blocked",
                        event.event_type === "waiting_user" && "bg-status-waiting/15 text-status-waiting",
                        event.event_type === "done" && "bg-status-done/15 text-status-done",
                        event.event_type === "idle" && "bg-muted text-muted-foreground"
                      )}
                    >
                      {EVENT_TYPE_LABELS[event.event_type] ?? event.event_type}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-foreground">{event.message}</p>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

type DetailTab = "events" | "media";

function DetailTabs({
  events,
  media,
  agentId,
}: {
  events: HistoryEvent[];
  media: HistoryMedia[];
  agentId: string;
}) {
  const [tab, setTab] = useState<DetailTab>("events");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const lightboxItems = useMemo(
    () =>
      media.map((m) => ({
        src: `/api/v1/agents/${agentId}/media/${m.file_name}`,
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

  const lightboxItem = lightboxIndex !== null ? lightboxItems[lightboxIndex] ?? null : null;

  return (
    <>
      <div>
        <div className="flex items-center gap-1 border-b border-border pb-0">
          {(["events", "media"] as const).map((t) => {
            const count = t === "events" ? events.length : media.length;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "relative px-3 py-1.5 text-xs font-medium transition-colors",
                  tab === t
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "events" ? "Events" : "Media"}
                {count > 0 && (
                  <span
                    className={cn(
                      "ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium",
                      tab === t
                        ? "bg-foreground/15 text-foreground"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {count}
                  </span>
                )}
                {tab === t && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-foreground" />
                )}
              </button>
            );
          })}
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
                      src={`/api/v1/agents/${agentId}/media/${m.file_name}`}
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

function AgentHistoryDetail({
  agentId,
  onBack,
}: {
  agentId: string;
  onBack: () => void;
}) {
  const { data, isLoading } = useHistoryAgentDetail(agentId);

  if (isLoading || !data) {
    return (
      <div className="space-y-4 p-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
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

  const { agent, events, tokenUsage, media, stateDurations } = data;
  const durationMs =
    new Date(agent.updatedAt).getTime() - new Date(agent.createdAt).getTime();
  const totalTokens =
    tokenUsage.total_input +
    tokenUsage.total_cache_creation +
    tokenUsage.total_cache_read +
    tokenUsage.total_output;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-3 pt-4 pb-12 sm:space-y-8 sm:px-5 sm:pt-6 sm:pb-20 md:px-8">
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
          <h2 className="text-base font-semibold text-foreground">{agent.name}</h2>
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
              <span className="font-mono text-[11px]">{shortProjectName(agent.gitContext.worktreePath)}</span>
            </div>
          )}
          {agent.cwd !== agent.gitContext?.repoRoot && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px]">Directory</span>
              <span className="font-mono text-[11px]">{shortProjectName(agent.cwd)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="flex flex-wrap gap-2 sm:gap-3">
        <StatCard label="Total duration" value={formatDuration(durationMs)} />
        <StatCard label="Working" value={formatDuration(stateDurations.working ?? 0)} />
        <StatCard label="Blocked" value={formatDuration(stateDurations.blocked ?? 0)} />
        <StatCard label="Waiting" value={formatDuration(stateDurations.waiting_user ?? 0)} />
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
          <h3 className="mb-2 text-sm font-medium text-foreground">Duration breakdown</h3>
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
                    {EVENT_TYPE_LABELS[key]}: {formatDuration(stateDurations[key])}
                  </span>
                )
            )}
          </div>
        </div>
      )}

      {/* Tabbed: Events / Media */}
      <DetailTabs events={events} media={media} agentId={agentId} />
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────

export function AgentHistoryTab({
  range,
  onRangeChange,
}: {
  range: ActivityRange;
  onRangeChange: (r: ActivityRange) => void;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  if (selectedAgentId) {
    return (
      <AgentHistoryDetail
        agentId={selectedAgentId}
        onBack={() => setSelectedAgentId(null)}
      />
    );
  }

  return (
    <AgentHistoryList
      onSelect={setSelectedAgentId}
      range={range}
      onRangeChange={onRangeChange}
    />
  );
}
