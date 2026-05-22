import { useEffect, useState } from "react";
import { CalendarIcon } from "lucide-react";
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
import { formatDuration, formatTokenCount } from "@/lib/format";
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
  rangeLabel,
  type ActivityRange,
} from "@/hooks/use-activity";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import {
  cacheHitRate,
  DailyStackedBarChart,
  DailyTokenChart,
  formatDate,
  ModelBreakdown,
  ProjectBreakdown,
} from "@/components/app/activity-charts";
import { ActiveHoursGrid, Heatmap } from "@/components/app/activity-heatmaps";

type ActivityTab = "metrics" | "history";

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
