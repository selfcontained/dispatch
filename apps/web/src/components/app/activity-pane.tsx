import { useEffect, useState } from "react";
import { CalendarIcon, RefreshCw } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { AgentHistoryTab } from "@/components/app/agent-history-tab";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatDuration,
  formatRelativeTime,
  formatShortDateTime,
  formatTokenCount,
} from "@/lib/format";
import { StatCard } from "@/components/app/stat-card";
import {
  ACTIVITY_RANGES,
  useActiveHours,
  useActivityHeatmap,
  useActivityStats,
  useAgentsCreated,
  useDailyStatus,
  useTokenStats,
  useTokenDaily,
  useTokenByModel,
  useTokenByProject,
  useWorkingTimeByProject,
  useProviderQuotas,
  useProviderQuotaHistory,
  useRefreshProviderQuotas,
  useUpdateProviderQuotaSettings,
  rangeLabel,
  type ActivityRange,
  type ProviderQuotaSnapshot,
} from "@/hooks/use-activity";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import {
  DailyStackedBarChart,
  DailyTokenChart,
  ModelBreakdown,
  ProviderQuotaLeftOnTableChart,
  ProviderQuotaUtilizationChart,
  ProjectBreakdown,
} from "@/components/app/activity-charts";
import { formatDate } from "@/components/app/activity-chart-utils";
import { ActiveHoursGrid, Heatmap } from "@/components/app/activity-heatmaps";
import type { TokenStats } from "@/hooks/use-activity";

type ActivityTab = "metrics" | "history";
const PROVIDER_QUOTA_STALE_MS = 30 * 60 * 1000;

function cacheHitRate(stats: TokenStats): number {
  const totalInput =
    stats.total_input + stats.total_cache_creation + stats.total_cache_read;
  if (totalInput === 0) return 0;
  return Math.round((stats.total_cache_read / totalInput) * 100);
}

function quotaPercentLabel(snapshot: ProviderQuotaSnapshot): string {
  return snapshot.usedPercent === null
    ? "n/a"
    : `${Math.round(snapshot.usedPercent)}%`;
}

function quotaResetLabel(snapshot: ProviderQuotaSnapshot): string | null {
  if (!snapshot.resetsAt) return "Reset time unavailable";
  return `resets ${formatShortDateTime(snapshot.resetsAt)}`;
}

function isQuotaBucket(snapshot: ProviderQuotaSnapshot): boolean {
  return (
    snapshot.windowId.includes(":") || snapshot.windowId.startsWith("credits")
  );
}

function providerLabel(provider: ProviderQuotaSnapshot["provider"]): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function titleFromId(id: string): string {
  return id
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function codexBucketName(snapshot: ProviderQuotaSnapshot): string {
  const [, bucketId] = snapshot.windowId.split(":");
  if (!bucketId) return "Additional quota";
  return titleFromId(bucketId);
}

function quotaDisplayTitle(snapshot: ProviderQuotaSnapshot): string {
  const id = snapshot.windowId.toLowerCase();
  if (snapshot.provider === "codex") {
    if (id === "primary_window") return "Session";
    if (id === "secondary_window") return "Weekly";
    if (id.startsWith("primary_window:")) return codexBucketName(snapshot);
    if (id.startsWith("secondary_window:")) return codexBucketName(snapshot);
    if (id.startsWith("credits:")) return snapshot.title || "Credits";
    return snapshot.title || "Additional Codex quota";
  }
  return snapshot.title;
}

function quotaContextLabel(snapshot: ProviderQuotaSnapshot): string | null {
  const id = snapshot.windowId.toLowerCase();
  if (snapshot.provider === "codex") {
    if (id === "primary_window") return "Current Codex quota";
    if (id === "secondary_window") return "Weekly Codex quota";
    if (id.startsWith("primary_window:")) {
      return "Model-scoped session quota";
    }
    if (id.startsWith("secondary_window:")) {
      return "Model-scoped weekly quota";
    }
    if (id.startsWith("credits:")) return "Codex credits";
    if (isQuotaBucket(snapshot)) return "Additional Codex quota";
  }
  if (id === "five_hour" || id.includes("session")) return "Session quota";
  if (id === "seven_day" || id.includes("weekly_all")) return "Weekly quota";
  if (id.includes("weekly_scoped")) return "Model-scoped weekly quota";
  if (id.includes("sonnet")) return "Sonnet model quota";
  if (id.includes("opus")) return "Opus model quota";
  if (id.includes("primary_window")) return "Main account window";
  if (id.includes("secondary_window")) return "Longer account window";
  if (id.startsWith("credits")) return "Credit balance";
  if (id.includes("gpt") || id.includes("model")) return "Model-scoped quota";
  return isQuotaBucket(snapshot) ? "Scoped quota" : null;
}

function visibleQuotaSnapshots(
  provider: ProviderQuotaSnapshot["provider"],
  snapshots: ProviderQuotaSnapshot[]
): ProviderQuotaSnapshot[] {
  const okSnapshots = snapshots.filter((snapshot) => snapshot.status === "ok");
  if (provider !== "claude") return okSnapshots;
  const hasFiveHour = okSnapshots.some(
    (snapshot) => snapshot.windowId === "five_hour" && snapshot.status === "ok"
  );
  const hasSevenDay = okSnapshots.some(
    (snapshot) => snapshot.windowId === "seven_day" && snapshot.status === "ok"
  );
  if (!hasFiveHour && !hasSevenDay) return okSnapshots;
  return okSnapshots.filter((snapshot) => {
    if (hasFiveHour && snapshot.windowId === "limits:session:session") {
      return false;
    }
    if (hasSevenDay && snapshot.windowId === "limits:weekly_all:weekly") {
      return false;
    }
    return true;
  });
}

function newestQuotaSnapshot(
  snapshots: ProviderQuotaSnapshot[]
): ProviderQuotaSnapshot | null {
  return snapshots.reduce<ProviderQuotaSnapshot | null>((newest, snapshot) => {
    if (!newest) return snapshot;
    return new Date(snapshot.fetchedAt).getTime() >
      new Date(newest.fetchedAt).getTime()
      ? snapshot
      : newest;
  }, null);
}

function ProviderQuotaProgressRow({
  snapshot,
}: {
  snapshot: ProviderQuotaSnapshot;
}): JSX.Element {
  const percent =
    snapshot.usedPercent === null
      ? null
      : Math.max(0, Math.min(snapshot.usedPercent, 100));
  const resetLabel = quotaResetLabel(snapshot);
  const contextLabel = quotaContextLabel(snapshot);

  return (
    <div className="min-w-0">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">
              {quotaDisplayTitle(snapshot)}
            </div>
            {contextLabel && (
              <div className="truncate text-[10px] text-muted-foreground">
                {contextLabel}
              </div>
            )}
          </div>
          <span className="shrink-0 text-xs font-semibold text-foreground">
            {quotaPercentLabel(snapshot)}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
          <div
            className={
              snapshot.status === "ok"
                ? "h-full rounded-full bg-primary"
                : "h-full rounded-full bg-status-blocked"
            }
            style={{ width: `${percent ?? 100}%` }}
          />
        </div>
        {(resetLabel || snapshot.windowMinutes !== null) && (
          <div className="mt-1 flex min-h-3 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            {snapshot.windowMinutes !== null && (
              <span>{formatDuration(snapshot.windowMinutes * 60_000)}</span>
            )}
            {resetLabel && <span>{resetLabel}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProviderQuotaSection({
  range = "30d",
  dailyDate,
}: {
  range?: ActivityRange;
  dailyDate?: string;
}): JSX.Element {
  const { data, isLoading, isError } = useProviderQuotas();
  const { data: history, isLoading: historyLoading } = useProviderQuotaHistory(
    range,
    dailyDate
  );
  const refresh = useRefreshProviderQuotas();
  const updateSettings = useUpdateProviderQuotaSettings();
  const snapshots = data?.snapshots ?? [];
  const providerGroups = Array.from(
    snapshots
      .reduce<
        Map<
          string,
          {
            provider: ProviderQuotaSnapshot["provider"];
            snapshots: ProviderQuotaSnapshot[];
          }
        >
      >((groups, snapshot) => {
        const providerGroup =
          groups.get(snapshot.provider) ??
          (() => {
            const group = {
              provider: snapshot.provider,
              snapshots: [],
            };
            groups.set(snapshot.provider, group);
            return group;
          })();
        providerGroup.snapshots.push(snapshot);
        return groups;
      }, new Map())
      .values()
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Provider quotas</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          data-testid="provider-quota-refresh"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refresh.isPending ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
      {isLoading ? (
        <div className="h-24 animate-pulse rounded-md bg-muted/30" />
      ) : data?.usageTrackingEnabled === false ? (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium text-foreground">
            Usage tracking is off
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Enable usage tracking to keep Codex and Claude quota stats up to
            date in the background. Dispatch chooses the available local
            credential path automatically.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            disabled={updateSettings.isPending}
            onClick={() =>
              updateSettings.mutate(
                { usageTrackingEnabled: true },
                {
                  onSuccess: () => refresh.mutate(),
                }
              )
            }
          >
            Enable usage tracking
          </Button>
        </div>
      ) : isError ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-status-blocked">
          Could not load provider quota snapshots.
        </div>
      ) : providerGroups.length > 0 ? (
        <div className="space-y-6">
          <div className="grid gap-3 lg:grid-cols-2">
            {providerGroups.map((providerGroup) => {
              const visibleSnapshots = visibleQuotaSnapshots(
                providerGroup.provider,
                providerGroup.snapshots
              );
              const windowSnapshots = visibleSnapshots.filter(
                (snapshot) => !isQuotaBucket(snapshot)
              );
              const bucketSnapshots = visibleSnapshots.filter(isQuotaBucket);
              const newestGoodSnapshot = newestQuotaSnapshot(visibleSnapshots);
              const newestSnapshot =
                newestGoodSnapshot ??
                newestQuotaSnapshot(providerGroup.snapshots);
              const newestFetchedAtMs = newestGoodSnapshot
                ? new Date(newestGoodSnapshot.fetchedAt).getTime()
                : NaN;
              const newestAnyFetchedAtMs = newestSnapshot
                ? new Date(newestSnapshot.fetchedAt).getTime()
                : NaN;
              const isProviderStale =
                Number.isFinite(newestFetchedAtMs) &&
                Date.now() - newestFetchedAtMs > PROVIDER_QUOTA_STALE_MS;
              const latestFailure = providerGroup.snapshots
                .filter((snapshot) => snapshot.status !== "ok")
                .sort(
                  (a, b) =>
                    new Date(b.fetchedAt).getTime() -
                    new Date(a.fetchedAt).getTime()
                )[0];
              const failureIsLatest =
                latestFailure &&
                Number.isFinite(newestAnyFetchedAtMs) &&
                new Date(latestFailure.fetchedAt).getTime() >=
                  newestAnyFetchedAtMs;
              const hasProviderStatus = Boolean(
                isProviderStale ||
                failureIsLatest ||
                (latestFailure && !newestGoodSnapshot)
              );
              return (
                <div
                  key={providerGroup.provider}
                  className="flex min-h-[19rem] flex-col rounded-md border border-border bg-muted/20 p-3"
                >
                  <div className="flex-1">
                    <div className="mb-3">
                      <h3 className="text-sm font-semibold text-foreground">
                        {providerLabel(providerGroup.provider)}
                      </h3>
                    </div>
                    {windowSnapshots.length > 0 && (
                      <div>
                        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                          Windows
                        </div>
                        <div className="space-y-2">
                          {windowSnapshots.map((snapshot) => (
                            <ProviderQuotaProgressRow
                              key={snapshot.id}
                              snapshot={snapshot}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {bucketSnapshots.length > 0 && (
                      <div className={windowSnapshots.length > 0 ? "mt-3" : ""}>
                        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                          Buckets
                        </div>
                        <div className="space-y-2">
                          {bucketSnapshots.map((snapshot) => (
                            <ProviderQuotaProgressRow
                              key={snapshot.id}
                              snapshot={snapshot}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {hasProviderStatus && (
                      <div className="mt-3 rounded-md border border-status-blocked/30 bg-status-blocked/10 px-2 py-1.5 text-[10px] text-status-blocked">
                        {failureIsLatest && newestGoodSnapshot ? (
                          <div>
                            Refresh failed; showing last checked data from{" "}
                            {formatRelativeTime(newestGoodSnapshot.fetchedAt)}.
                          </div>
                        ) : isProviderStale && newestGoodSnapshot ? (
                          <div>
                            Stats are stale. Last checked{" "}
                            {formatRelativeTime(newestGoodSnapshot.fetchedAt)}.
                          </div>
                        ) : (
                          <div>
                            Stats unavailable. Try refreshing provider quotas.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="mt-3 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
                    Last checked{" "}
                    {newestGoodSnapshot
                      ? formatRelativeTime(newestGoodSnapshot.fetchedAt)
                      : "never"}
                    {isProviderStale ? " · stale" : ""}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="space-y-5">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                Average utilization
              </h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Average observed account quota use across the selected range.
              </p>
              {historyLoading ? (
                <div className="h-56 animate-pulse rounded-md bg-muted/30" />
              ) : history && history.series.length > 0 ? (
                <ProviderQuotaUtilizationChart
                  series={history.series}
                  granularity={history.granularity}
                />
              ) : (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
                  No quota history yet. New refreshes append observations here.
                </div>
              )}
            </div>
            {history && history.completedWindows.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-foreground">
                  Left on the table
                </h3>
                <p className="mb-3 text-xs text-muted-foreground">
                  Unused account quota at completed resets.
                </p>
                <ProviderQuotaLeftOnTableChart
                  completedWindows={history.completedWindows}
                  granularity={history.granularity}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
          No provider quota snapshots yet. Refresh to fetch Codex and Claude.
        </div>
      )}
    </div>
  );
}

type ActivityPaneProps = {
  open: boolean;
  initialTab?: ActivityTab;
};

// ── Date picker with z-index fix for dialog context ─────────────────

function DatePickerPopover({
  dailyDate,
  onDateChange,
}: {
  dailyDate: string;
  onDateChange: (date: string) => void;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);

  useRadixPopoverZFix();

  return (
    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="default"
          className="h-8 gap-1.5 bg-muted/30 text-xs font-normal"
          data-testid="activity-date-picker"
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {new Date(dailyDate + "T00:00:00").toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto bg-muted p-0 shadow-lg" align="end">
        <Calendar
          mode="single"
          selected={new Date(dailyDate + "T00:00:00")}
          onSelect={(date) => {
            if (date) {
              onDateChange(
                `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
              );
              setCalendarOpen(false);
            }
          }}
          disabled={{ after: new Date() }}
        />
      </PopoverContent>
    </Popover>
  );
}

// ── Main pane ───────────────────────────────────────────────────────

/** Activity content for the main content area. */
export function ActivityPane({
  open,
  initialTab,
}: ActivityPaneProps): JSX.Element {
  const [range, setRange] = useState<ActivityRange>("7d");
  const [dailyDate, setDailyDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [tab, setTabState] = useState<ActivityTab>(initialTab ?? "metrics");

  useEffect(() => {
    if (open && initialTab) {
      setTabState(initialTab);
    }
  }, [open, initialTab]);

  const isDaily = range === "daily";
  const dailyDateParam = isDaily ? dailyDate : undefined;

  const { data: heatmapData } = useActivityHeatmap();
  const { data: stats } = useActivityStats(range, dailyDateParam);
  const { data: dailyStatus } = useDailyStatus(range, dailyDateParam);
  const { data: activeHours } = useActiveHours(range, dailyDateParam);
  const { data: tokenStats } = useTokenStats(range, dailyDateParam);
  const { data: tokenDaily } = useTokenDaily(range, dailyDateParam);
  const { data: tokenByModel } = useTokenByModel(range, dailyDateParam);
  const { data: tokenByProject } = useTokenByProject(range, dailyDateParam);
  const { data: agentsCreated } = useAgentsCreated(range, dailyDateParam);
  const { data: workingTimeByProject } = useWorkingTimeByProject(
    range,
    dailyDateParam
  );

  const hasData =
    stats &&
    (stats.totalWorkingMs > 0 ||
      stats.avgBlockedMs > 0 ||
      stats.avgWaitingMs > 0);
  const totalTokens = tokenStats
    ? tokenStats.total_input +
      tokenStats.total_cache_creation +
      tokenStats.total_cache_read +
      tokenStats.total_output
    : 0;
  const hasTokenData = totalTokens > 0;
  const hasActiveHourData =
    activeHours?.some((cell) => cell.count > 0) ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header with range selector */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
        <div className="ml-auto flex items-center gap-2">
          {tab === "metrics" && (
            <>
              {isDaily && (
                <DatePickerPopover
                  dailyDate={dailyDate}
                  onDateChange={setDailyDate}
                />
              )}
              <Select
                value={range}
                onValueChange={(value) => setRange(value as ActivityRange)}
              >
                <SelectTrigger
                  className="h-8 w-[132px] bg-muted/30 text-xs"
                  data-testid="activity-range-select"
                  aria-label="Activity time range"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_RANGES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {rangeLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      </div>

      {/* History tab */}
      {tab === "history" && (
        <ScrollArea className="flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
          <AgentHistoryTab range={range} onRangeChange={setRange} />
        </ScrollArea>
      )}

      {/* Metrics tab body */}
      {tab === "metrics" && (
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-5xl min-w-0 overflow-hidden space-y-6 px-3 pt-4 pb-12 sm:space-y-8 sm:px-5 sm:pt-6 sm:pb-20 md:px-8">
            {hasTokenData && tokenStats && (
              <div className="flex flex-wrap gap-2 sm:gap-3">
                <StatCard
                  label="Total tokens"
                  value={formatTokenCount(totalTokens)}
                  sub={`${formatTokenCount(tokenStats.total_output)} output`}
                />
                <StatCard
                  label="Cache hit rate"
                  value={`${cacheHitRate(tokenStats)}%`}
                  sub="of input from cache"
                />
                <StatCard
                  label="Avg tokens / session"
                  value={
                    tokenStats.total_sessions > 0
                      ? formatTokenCount(
                          Math.round(totalTokens / tokenStats.total_sessions)
                        )
                      : "—"
                  }
                />
                <StatCard
                  label="Sessions"
                  value={tokenStats.total_sessions}
                  sub={`${tokenStats.total_messages} messages`}
                />
                {agentsCreated && agentsCreated.total > 0 && (
                  <StatCard
                    label="Agents created"
                    value={agentsCreated.total}
                  />
                )}
              </div>
            )}

            {tokenDaily && tokenDaily.days.length > 0 && (
              <div>
                <h2 className="mb-3 text-sm font-medium text-foreground">
                  Token usage (
                  {isDaily
                    ? new Date(dailyDate + "T00:00:00").toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" }
                      )
                    : rangeLabel(range).toLowerCase()}
                  )
                </h2>
                <DailyTokenChart
                  data={tokenDaily.days}
                  granularity={tokenDaily.granularity}
                  agentsCreatedData={agentsCreated?.days}
                  dailyDate={dailyDateParam}
                />
              </div>
            )}

            {hasTokenData &&
            (tokenByModel?.length || tokenByProject?.length) ? (
              <div className="grid gap-6 sm:grid-cols-2">
                {tokenByModel && tokenByModel.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-sm font-medium text-foreground">
                      Tokens by model
                    </h2>
                    <ModelBreakdown data={tokenByModel} />
                  </div>
                )}
                {tokenByProject && tokenByProject.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-sm font-medium text-foreground">
                      By project
                    </h2>
                    <ProjectBreakdown
                      data={tokenByProject}
                      workingTime={workingTimeByProject}
                    />
                  </div>
                )}
              </div>
            ) : null}

            <div>
              <h2 className="mb-3 text-sm font-medium text-foreground">
                Activity this year
              </h2>
              {heatmapData ? (
                <Heatmap data={heatmapData} />
              ) : (
                <div className="h-24 animate-pulse rounded-md bg-muted/30" />
              )}
            </div>

            {activeHours && activeHours.length > 0 && hasActiveHourData && (
              <div className="min-w-0">
                <h2 className="mb-1 text-sm font-medium text-foreground">
                  Active hours
                </h2>
                <p className="mb-3 text-xs text-muted-foreground">
                  {isDaily
                    ? "Active-state events by weekday and hour for the selected day."
                    : range === "7d"
                      ? "Active-state events by weekday and hour for the last 7 days."
                      : `Average active-state events per week by weekday and hour for ${rangeLabel(range).toLowerCase()}.`}
                </p>
                <ActiveHoursGrid data={activeHours} range={range} />
              </div>
            )}

            {stats && hasData && (
              <div className="flex flex-wrap gap-2 sm:gap-3">
                <StatCard
                  label="Total working time"
                  value={formatDuration(stats.totalWorkingMs)}
                />
                <StatCard
                  label="Avg blocked time"
                  value={formatDuration(stats.avgBlockedMs)}
                />
                <StatCard
                  label="Avg waiting time"
                  value={formatDuration(stats.avgWaitingMs)}
                />
                <StatCard
                  label="Busiest day"
                  value={stats.busiestDay ? formatDate(stats.busiestDay) : "—"}
                  sub={
                    stats.busiestDayCount > 0
                      ? `${stats.busiestDayCount} events`
                      : undefined
                  }
                />
              </div>
            )}

            {dailyStatus && dailyStatus.days.length > 0 && (
              <div>
                <h2 className="mb-3 text-sm font-medium text-foreground">
                  Status breakdown (
                  {isDaily
                    ? new Date(dailyDate + "T00:00:00").toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" }
                      )
                    : rangeLabel(range).toLowerCase()}
                  )
                </h2>
                <DailyStackedBarChart
                  data={dailyStatus.days}
                  granularity={dailyStatus.granularity}
                  dailyDate={dailyDateParam}
                />
              </div>
            )}

            {stats &&
              !hasData &&
              (!heatmapData || heatmapData.length === 0) &&
              !hasTokenData && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No activity yet. Stats will appear here as agents run.
                </div>
              )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
