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
import { PageContent, PageHeader } from "@/components/ui/page-header";
import {
  ChartFrame,
  DashboardSection,
  StatGrid,
} from "@/components/ui/dashboard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatCount,
  formatLongDate,
  formatShortDate,
  formatTokenCount,
} from "@/lib/format";
import { Panel } from "@/components/ui/card";
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
import { AsyncBoundary, combineResults } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton, Skeleton } from "@/components/ui/skeleton";

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

function TokenUsageSkeleton() {
  return (
    <LoadingSkeleton label="Loading token usage…" className="space-y-6">
      <StatGrid>
        {Array.from({ length: 4 }, (_, card) => (
          <Skeleton key={card} className="h-20" />
        ))}
      </StatGrid>
      <Skeleton className="h-56 sm:h-64" />
    </LoadingSkeleton>
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
  const combined = combineResults(...tokenQueries);
  // A failed breakdown doesn't hide what the others loaded.
  const tokenRegion = {
    ...combined,
    data:
      tokenStats &&
      tokenQueries.every((query) => query.data !== undefined || query.error)
        ? tokenStats
        : undefined,
  };
  const totalTokens = tokenStats
    ? tokenStats.total_input +
      tokenStats.total_cache_creation +
      tokenStats.total_cache_read +
      tokenStats.total_output
    : 0;
  const hasTokenData = totalTokens > 0;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <PageHeader
        title={tab === "history" ? "History" : "Metrics"}
        description={
          tab === "history"
            ? "Finished agent sessions"
            : "Token use and AI decisions"
        }
        actions={
          tab === "metrics" ? (
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
          ) : null
        }
      />

      {/* History tab */}
      {tab === "history" && (
        <PageContent>
          <AgentHistoryTab range={range} onRangeChange={setRange} />
        </PageContent>
      )}

      {/* Metrics tab body */}
      {tab === "metrics" && (
        <PageContent className="space-y-8">
          <AsyncBoundary
            query={tokenRegion}
            thing="token usage"
            loading={<TokenUsageSkeleton />}
            isEmpty={() => !hasTokenData}
            empty={
              <EmptyState
                title="No token usage yet."
                description="Usage from agent sessions in this range shows here."
              />
            }
          >
            {() => (
              <>
                {hasTokenData && tokenStats && (
                  <StatGrid>
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
                              Math.round(
                                totalTokens / tokenStats.total_sessions
                              )
                            )
                          : "—"
                      }
                    />
                    <StatCard
                      label="Sessions"
                      value={tokenStats.total_sessions}
                      sub={formatCount(tokenStats.total_messages, "message")}
                    />
                  </StatGrid>
                )}

                {tokenDaily && tokenDaily.days.length > 0 && (
                  <DashboardSection
                    title="Token usage"
                    range={
                      isDaily
                        ? formatShortDate(dailyDate)
                        : rangeLabel(range).toLowerCase()
                    }
                  >
                    <ChartFrame>
                      <DailyTokenChart
                        data={tokenDaily.days}
                        granularity={tokenDaily.granularity}
                        dailyDate={dailyDateParam}
                      />
                    </ChartFrame>
                  </DashboardSection>
                )}

                {hasTokenData &&
                (tokenByModel?.length || tokenByProject?.length) ? (
                  <div className="grid gap-8 sm:grid-cols-2 sm:gap-6">
                    {tokenByModel && tokenByModel.length > 0 && (
                      <DashboardSection title="Tokens by model">
                        <Panel>
                          <ModelBreakdown data={tokenByModel} />
                        </Panel>
                      </DashboardSection>
                    )}
                    {tokenByProject && tokenByProject.length > 0 && (
                      <DashboardSection title="Tokens by project">
                        <Panel>
                          <ProjectBreakdown data={tokenByProject} />
                        </Panel>
                      </DashboardSection>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </AsyncBoundary>
          <DecisionMetricsSection range={range} dailyDate={dailyDateParam} />
        </PageContent>
      )}
    </div>
  );
}
