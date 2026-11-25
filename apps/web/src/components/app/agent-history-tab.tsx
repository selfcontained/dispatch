import { AgentSessionLink } from "./agent-session-link";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ChevronUp, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CountBubble } from "@/components/ui/count-bubble";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatTokenCount,
  formatRelativeTime,
  shortProjectName,
} from "@/lib/format";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { AgentHistoryDetail } from "@/components/app/agent-history-detail";
import {
  useHistoryAgents,
  useHistoryProjects,
  type HistoryFilters,
} from "@/hooks/use-agent-history";
import {
  ACTIVITY_RANGES,
  rangeLabel,
  type ActivityRange,
} from "@/hooks/use-activity";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";

// ── Helpers ─────────────────────────────────────────────────────────

// ── List View ───────────────────────────────────────────────────────

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
  const [sort, setSort] = useState<SortKey>("updated_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const filters: HistoryFilters = useMemo(
    () => ({
      search: debouncedSearch,
      type,
      project,
      range,
      sort,
      order,
      offset: 0,
    }),
    [debouncedSearch, type, project, range, sort, order]
  );

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const query = useHistoryAgents(filters);
  const { data } = query;
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

  const clearFilters = () => {
    setSearch("");
    setType("");
    setProject("");
    onRangeChange("all");
  };
  const hasActiveFilters =
    debouncedSearch || type || project || range !== "all";

  return (
    <div className="flex min-w-0 flex-col">
      {/* Search + filters */}
      <div className="space-y-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute z-sticky left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-body-sm"
          />
          {search && (
            <IconButton
              size="icon-xs"
              label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
            >
              <X />
            </IconButton>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={type || "__all__"}
            onValueChange={(v) => setType(v === "__all__" ? "" : v)}
          >
            <SelectTrigger className="h-7 w-32 text-label-sm pointer-coarse:h-11">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All types</SelectItem>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectContent>
          </Select>

          {projects && projects.length > 0 && (
            <Select
              value={project || "__all__"}
              onValueChange={(v) => setProject(v === "__all__" ? "" : v)}
            >
              <SelectTrigger className="h-7 max-w-[180px] text-label-sm pointer-coarse:h-11">
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

          <Select
            value={range}
            onValueChange={(v) => onRangeChange(v as ActivityRange)}
          >
            <SelectTrigger className="h-7 w-[120px] text-label-sm pointer-coarse:h-11">
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
            <Button variant="ghost" size="xs" onClick={clearFilters}>
              Clear filters
            </Button>
          )}

          {data && (
            <span className="ml-auto text-label-sm text-muted-foreground">
              {formatCount(data.total, "agent")}
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex min-w-0 flex-col">
        <AsyncBoundary
          query={query}
          thing="agent history"
          className="my-2"
          loading={
            <LoadingSkeleton
              label="Loading agent history…"
              rows={5}
              className="py-2"
            />
          }
          isEmpty={({ agents }) => agents.length === 0}
          empty={
            hasActiveFilters ? (
              <EmptyState
                title="No agents match the current filters."
                action={
                  <Button size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No agents found."
                description="Agent sessions show here once they finish."
              />
            )
          }
        >
          {(data) => (
            <>
              <table className="w-full text-body-sm">
                <thead className="sticky top-0 z-sticky bg-fill-inset backdrop-blur-xl">
                  <tr className="border-b border-border text-left text-label-sm text-muted-foreground">
                    <th
                      className="cursor-pointer px-3 py-2 font-medium sm:px-4"
                      onClick={() => toggleSort("name")}
                    >
                      Name{" "}
                      {sort === "name" &&
                        (order === "desc" ? (
                          <ChevronDown className="ml-0.5 inline h-3 w-3" />
                        ) : (
                          <ChevronUp className="ml-0.5 inline h-3 w-3" />
                        ))}
                    </th>
                    <th className="hidden px-2 py-2 font-medium sm:table-cell">
                      Project
                    </th>
                    <th className="hidden px-2 py-2 font-medium sm:table-cell">
                      Duration
                    </th>
                    <th className="px-2 py-2 font-medium">Tokens</th>
                    <th
                      className="cursor-pointer px-2 py-2 pr-3 font-medium sm:pr-4"
                      onClick={() => toggleSort("updated_at")}
                    >
                      Finished{" "}
                      {sort === "updated_at" &&
                        (order === "desc" ? (
                          <ChevronDown className="ml-0.5 inline h-3 w-3" />
                        ) : (
                          <ChevronUp className="ml-0.5 inline h-3 w-3" />
                        ))}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((agent) => {
                    const hasChildren = agent.children.length > 0;
                    const isExpanded = expandedIds.has(agent.id);
                    return (
                      <Fragment key={agent.id}>
                        <tr
                          className="cursor-pointer border-b border-border-subtle transition-colors hover:bg-surface-hover"
                          onClick={() => onSelect(agent.id)}
                        >
                          <td className="w-full max-w-0 py-3 pl-1 pr-2 sm:w-auto sm:max-w-72 sm:px-4">
                            <div className="flex items-center gap-1.5">
                              {hasChildren ? (
                                <IconButton
                                  size="icon-sm"
                                  className="-my-1.5"
                                  label={
                                    isExpanded
                                      ? "Hide child agents"
                                      : "Show child agents"
                                  }
                                  aria-expanded={isExpanded}
                                  onClick={(e) => toggleExpanded(agent.id, e)}
                                >
                                  {isExpanded ? (
                                    <ChevronDown />
                                  ) : (
                                    <ChevronRight />
                                  )}
                                </IconButton>
                              ) : (
                                <span className="w-7 flex-shrink-0 pointer-coarse:w-11" />
                              )}
                              <AgentSessionLink
                                agentId={agent.id}
                                name={agent.name}
                              >
                                <AgentTypeIcon type={agent.type} />
                              </AgentSessionLink>
                              <span className="min-w-0 truncate font-medium text-foreground">
                                <AgentSessionLink
                                  agentId={agent.id}
                                  name={agent.name}
                                />
                              </span>
                              {hasChildren && (
                                <CountBubble count={agent.children.length} />
                              )}
                            </div>
                          </td>
                          <td className="hidden px-2 py-2 text-muted-foreground sm:table-cell">
                            <span
                              className="truncate"
                              title={
                                agent.project === undefined
                                  ? (agent.gitContext?.repoRoot ?? agent.cwd)
                                  : (agent.project ?? "")
                              }
                            >
                              {shortProjectName(
                                agent.project === undefined
                                  ? (agent.gitContext?.repoRoot ?? agent.cwd)
                                  : (agent.project ?? "")
                              )}
                            </span>
                          </td>
                          <td className="hidden px-2 py-2 text-muted-foreground sm:table-cell">
                            {formatDuration(agent.durationMs)}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground">
                            {hasChildren ? (
                              <div>
                                <span>
                                  {formatTokenCount(agent.groupTotalTokens)}
                                </span>
                                <span className="ml-1 text-label-xs text-faint">
                                  ({formatTokenCount(agent.totalTokens)})
                                </span>
                              </div>
                            ) : agent.totalTokens > 0 ? (
                              formatTokenCount(agent.totalTokens)
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-2 py-2 pr-3 text-muted-foreground sm:pr-4">
                            <Hint label={formatDateTime(agent.updatedAt)}>
                              <span>{formatRelativeTime(agent.updatedAt)}</span>
                            </Hint>
                          </td>
                        </tr>
                        {hasChildren &&
                          isExpanded &&
                          agent.children.map((child) => (
                            <tr
                              key={child.id}
                              className="cursor-pointer border-b border-border-subtle bg-surface-subtle transition-colors hover:bg-surface-hover"
                              onClick={() => onSelect(child.id)}
                            >
                              <td className="max-w-0 py-2 pl-6 pr-2 sm:pl-12 sm:pr-4">
                                <div className="flex items-center gap-2">
                                  <Badge size="sm">
                                    {child.persona ??
                                      (child.role === "review"
                                        ? "review"
                                        : "agent")}
                                  </Badge>
                                  <span className="min-w-0 truncate text-muted-foreground">
                                    <AgentSessionLink
                                      agentId={child.id}
                                      name={child.name}
                                    />
                                  </span>
                                </div>
                              </td>
                              {/* The columns only its parent fills. */}
                              <td className="hidden sm:table-cell" />
                              <td className="hidden sm:table-cell" />
                              <td className="px-2 py-2 text-muted-foreground">
                                {child.totalTokens > 0
                                  ? formatTokenCount(child.totalTokens)
                                  : "—"}
                              </td>
                              <td className="px-2 py-2 pr-3 text-muted-foreground sm:pr-4">
                                <Hint label={formatDateTime(child.updatedAt)}>
                                  <span>
                                    {formatRelativeTime(child.updatedAt)}
                                  </span>
                                </Hint>
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>

              {data.agents.length < data.total && (
                <div className="py-3 text-center">
                  <p className="text-body-sm text-muted-foreground">
                    Showing {data.agents.length} of {data.total} agents — load
                    more coming soon
                  </p>
                </div>
              )}
            </>
          )}
        </AsyncBoundary>
      </div>
    </div>
  );
}

// ── Main Export ──────────────────────────────────────────────────────

export function AgentHistoryTab({
  range,
  onRangeChange,
}: {
  range: ActivityRange;
  onRangeChange: (r: ActivityRange) => void;
}) {
  const navigate = useNavigate();
  const { agentId: selectedAgentId } = useParams<{ agentId?: string }>();

  if (selectedAgentId) {
    return (
      <AgentHistoryDetail
        agentId={selectedAgentId}
        onBack={() => navigate("/activity/history")}
      />
    );
  }

  return (
    <AgentHistoryList
      onSelect={(id) => navigate(`/activity/history/${id}`)}
      range={range}
      onRangeChange={onRangeChange}
    />
  );
}
