import { DecisionMetricsSection } from "./decision-metrics";
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
import { LoadError } from "@/components/app/load-error";
import { ActivityBars } from "@/components/ui/activity-bars";
import {
  formatCount,
  formatLongDate,
  formatShortDate,
  formatTokenCount,
} from "@/lib/format";
import { StatCard } from "@/components/app/stat-card";
import {
  ACTIVITY_RANGES,
  useTokenStats,
  useTokenDaily,
  useTokenByModel,
  useTokenByProject,
  rangeLabel,
  type ActivityRange,
} from "@/hooks/use-activity";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import { DailyTokenChart } from "@/components/app/activity-token-chart";
import {
  ModelBreakdown,
  ProjectBreakdown,
} from "@/components/app/activity-breakdowns";
import type { TokenStats } from "@/hooks/use-activity";

type ActivityTab = "metrics" | "history";

function cacheHitRate(stats: TokenStats): number {
  const totalInput =
    stats.total_input + stats.total_cache_creation + stats.total_cache_read;
  if (totalInput === 0) return 0;
  return Math.round((stats.total_cache_read / totalInput) * 100);
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
          size="sm"
          className="bg-surface-subtle text-body-sm font-normal"
          data-testid="activity-date-picker"
        >
          <CalendarIcon />
          {formatLongDate(dailyDate)}
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

  const statsQuery = useTokenStats(range, dailyDateParam);
  const dailyQuery = useTokenDaily(range, dailyDateParam);
  const modelQuery = useTokenByModel(range, dailyDateParam);
  const projectQuery = useTokenByProject(range, dailyDateParam);
  const { data: tokenStats } = statsQuery;
  const { data: tokenDaily } = dailyQuery;
  const { data: tokenByModel } = modelQuery;
  const { data: tokenByProject } = projectQuery;
  // The four requests fill one region: it is empty only once all succeeded.
  const tokenQueries = [statsQuery, dailyQuery, modelQuery, projectQuery];
  const failedQueries = tokenQueries.filter((query) => query.isError);
  const tokensFailed = failedQueries.length > 0;
  const tokensLoading =
    !tokensFailed && tokenQueries.some((query) => query.isPending);
  const totalTokens = tokenStats
    ? tokenStats.total_input +
      tokenStats.total_cache_creation +
      tokenStats.total_cache_read +
      tokenStats.total_output
    : 0;
  const hasTokenData = totalTokens > 0;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header with range selector */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
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
                  className="h-8 w-[132px] bg-surface-subtle text-body-sm"
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
          <div className="mx-auto max-w-5xl min-w-0 overflow-hidden space-y-6 px-3 pt-4 pb-12 sm:space-y-8 sm:px-4 sm:pt-6 sm:pb-20 md:px-8">
            {tokensFailed && (
              <LoadError
                message="Couldn't load token usage"
                error={failedQueries[0].error}
                retrying={failedQueries.some((query) => query.isFetching)}
                onRetry={() =>
                  failedQueries.forEach((query) => void query.refetch())
                }
              />
            )}
            {tokensLoading && (
              <div className="flex items-center justify-center gap-2 py-12 text-body-md text-muted-foreground">
                <ActivityBars size={16} /> Loading token usage…
              </div>
            )}
            {!hasTokenData && !tokensLoading && !tokensFailed && (
              <div className="py-12 text-center text-body-md text-muted-foreground">
                No token usage yet.
              </div>
            )}
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
                  sub={formatCount(tokenStats.total_messages, "message")}
                />
              </div>
            )}

            {tokenDaily && tokenDaily.days.length > 0 && (
              <div>
                <h2 className="mb-3 text-heading-sm text-foreground">
                  Token usage (
                  {isDaily
                    ? formatShortDate(dailyDate)
                    : rangeLabel(range).toLowerCase()}
                  )
                </h2>
                <DailyTokenChart
                  data={tokenDaily.days}
                  granularity={tokenDaily.granularity}
                  dailyDate={dailyDateParam}
                />
              </div>
            )}

            {hasTokenData &&
            (tokenByModel?.length || tokenByProject?.length) ? (
              <div className="grid gap-6 sm:grid-cols-2">
                {tokenByModel && tokenByModel.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-heading-sm text-foreground">
                      Tokens by model
                    </h2>
                    <ModelBreakdown data={tokenByModel} />
                  </div>
                )}
                {tokenByProject && tokenByProject.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-heading-sm text-foreground">
                      By project
                    </h2>
                    <ProjectBreakdown data={tokenByProject} />
                  </div>
                )}
              </div>
            ) : null}

            <DecisionMetricsSection range={range} dailyDate={dailyDateParam} />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
