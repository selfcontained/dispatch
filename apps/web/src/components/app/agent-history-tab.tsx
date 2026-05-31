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
import {
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

// ── Helpers ─────────────────────────────────────────────────────────

function getAgentActivityAt(agent: {
  latestEvent?: { updatedAt: string } | null;
  updatedAt: string;
}): string {
  return agent.latestEvent?.updatedAt ?? agent.updatedAt;
}

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

  const hasActiveFilters =
    debouncedSearch || type || project || range !== "all";

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col px-3 sm:px-5 md:px-8">
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
          <Select
            value={type || "__all__"}
            onValueChange={(v) => setType(v === "__all__" ? "" : v)}
          >
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
            <Select
              value={project || "__all__"}
              onValueChange={(v) => setProject(v === "__all__" ? "" : v)}
            >
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

          <Select
            value={range}
            onValueChange={(v) => onRangeChange(v as ActivityRange)}
          >
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
          <thead className="sticky top-0 z-10 bg-white/[0.04] backdrop-blur-xl">
            <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
              <th
                className="cursor-pointer px-3 py-2 font-medium sm:px-5"
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
              <th className="px-2 py-2 font-medium">Duration</th>
              <th className="px-2 py-2 font-medium">Tokens</th>
              <th
                className="cursor-pointer px-2 py-2 pr-3 font-medium sm:pr-5"
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
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="px-3 py-2.5 sm:px-5" colSpan={5}>
                    <div className="h-4 w-full animate-pulse rounded bg-muted/30" />
                  </td>
                </tr>
              ))}

            {data?.agents.map((agent) => {
              const hasChildren = agent.children.length > 0;
              const isExpanded = expandedIds.has(agent.id);
              return (
                <Fragment key={agent.id}>
                  <tr
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
                    onClick={() => onSelect(agent.id)}
                  >
                    <td className="px-3 py-2.5 sm:px-5">
                      <div className="flex items-center gap-1.5">
                        {hasChildren ? (
                          <button
                            onClick={(e) => toggleExpanded(agent.id, e)}
                            className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                        ) : (
                          <span className="w-[18px] flex-shrink-0" />
                        )}
                        <AgentTypeIcon type={agent.type} />
                        <span className="truncate font-medium text-foreground">
                          {agent.name}
                        </span>
                        {hasChildren && (
                          <span className="flex-shrink-0 flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                            {agent.children.length}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-2 py-2.5 text-muted-foreground sm:table-cell">
                      <span
                        className="truncate"
                        title={agent.gitContext?.repoRoot ?? agent.cwd}
                      >
                        {shortProjectName(
                          agent.gitContext?.repoRoot ?? agent.cwd
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {formatDuration(agent.durationMs)}
                    </td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {hasChildren ? (
                        <div>
                          <span>
                            {formatTokenCount(agent.groupTotalTokens)}
                          </span>
                          <span className="ml-1 text-[10px] text-muted-foreground/60">
                            ({formatTokenCount(agent.totalTokens)})
                          </span>
                        </div>
                      ) : agent.totalTokens > 0 ? (
                        formatTokenCount(agent.totalTokens)
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-2.5 pr-3 text-muted-foreground sm:pr-5">
                      {formatRelativeTime(getAgentActivityAt(agent))}
                    </td>
                  </tr>
                  {hasChildren &&
                    isExpanded &&
                    agent.children.map((child) => (
                      <tr
                        key={child.id}
                        className="cursor-pointer border-b border-border/30 bg-muted/10 transition-colors hover:bg-muted/30"
                        onClick={() => onSelect(child.id)}
                      >
                        <td
                          colSpan={3}
                          className="py-2 pl-10 pr-3 sm:pl-12 sm:pr-5"
                        >
                          <div className="flex items-center gap-2">
                            <Badge className="h-4 px-1.5 text-[10px] font-normal">
                              {child.persona ?? "review"}
                            </Badge>
                            <span className="truncate text-muted-foreground">
                              {child.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {child.totalTokens > 0
                            ? formatTokenCount(child.totalTokens)
                            : "—"}
                        </td>
                        <td className="px-2 py-2 pr-3 text-muted-foreground sm:pr-5">
                          {formatRelativeTime(getAgentActivityAt(child))}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}

            {data && data.agents.length === 0 && !isLoading && (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-12 text-center text-sm text-muted-foreground"
                >
                  {hasActiveFilters
                    ? "No agents match the current filters."
                    : "No agents found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {data && data.agents.length < data.total && (
          <div className="py-3 text-center">
            <button className="text-xs text-muted-foreground hover:text-foreground">
              Showing {data.agents.length} of {data.total} agents — load more
              coming soon
            </button>
          </div>
        )}
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
