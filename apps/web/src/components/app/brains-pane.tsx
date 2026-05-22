import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  Brain,
  ChevronDown,
  ChevronRight,
  Database,
  List,
  Radio,
  Search,
} from "lucide-react";

import {
  useBrainProjects,
  useBrainCollections,
  useBrainObjects,
  useBrainLists,
  useBrainEvents,
  useBrainListItems,
  type BrainObject,
  type BrainList,
  type BrainEvent,
} from "@/hooks/use-brain";
import {
  CollapsibleSection,
  CopyButton,
  KeyValueTable,
  RelativeTime,
  decodeRepoRoot,
  encodeRepoRoot,
  getKindStyle,
} from "@/components/app/brain-tab-content";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function repoBasename(repoRoot: string): string {
  return repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
}

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
}

// ── Sidebar ─────────────────────────────────────────────────────

export function BrainsListContent({
  onItemSelect,
}: {
  onItemSelect?: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { encodedRepoRoot } = useParams<{ encodedRepoRoot?: string }>();
  const { data: projects = [], isLoading } = useBrainProjects();
  const showOverview = !encodedRepoRoot;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-md bg-muted/40"
              />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="font-medium text-foreground">
                No brain data yet.
              </div>
              <div className="mt-1 text-xs">
                Brain data will appear here when agents write shared memory.
              </div>
            </div>
          </div>
        ) : (
          <div>
            <button
              className={cn(
                "flex w-full items-center gap-2 border-b border-r-4 border-border border-r-transparent px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40",
                showOverview && "border-r-primary bg-muted/60"
              )}
              onClick={() => {
                navigate("/automations/brains");
                onItemSelect?.();
              }}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Overview</span>
            </button>
            {projects.map((project) => {
              const encoded = encodeRepoRoot(project.repoRoot);
              const selected = encodedRepoRoot === encoded;
              return (
                <div
                  key={project.repoRoot}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-muted/40",
                    selected && "border-r-primary bg-muted/60"
                  )}
                  onClick={() => {
                    navigate(`/automations/brains/${encoded}`);
                    onItemSelect?.();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/automations/brains/${encoded}`);
                      onItemSelect?.();
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold leading-5">
                        {repoBasename(project.repoRoot)}
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={project.repoRoot}
                      >
                        {shortPath(project.repoRoot)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
                      {project.objectCount > 0 ? (
                        <span className="flex items-center gap-0.5">
                          <Database className="h-2.5 w-2.5" />
                          {project.objectCount}
                        </span>
                      ) : null}
                      {project.listCount > 0 ? (
                        <span className="flex items-center gap-0.5">
                          <List className="h-2.5 w-2.5" />
                          {project.listCount}
                        </span>
                      ) : null}
                      {project.eventCount > 0 ? (
                        <span className="flex items-center gap-0.5">
                          <Radio className="h-2.5 w-2.5" />
                          {project.eventCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail Pane ──────────────────────────────────────────────────

export function BrainsDetailPane(): JSX.Element {
  const navigate = useNavigate();
  const { encodedRepoRoot, collection } = useParams<{
    encodedRepoRoot?: string;
    collection?: string;
  }>();

  if (!encodedRepoRoot) {
    return <BrainsOverview />;
  }

  let repoRoot: string;
  try {
    repoRoot = decodeRepoRoot(encodedRepoRoot);
  } catch {
    navigate("/automations/brains", { replace: true });
    return <BrainsOverview />;
  }

  return (
    <BrainProjectDetail
      repoRoot={repoRoot}
      encodedRepoRoot={encodedRepoRoot}
      selectedCollection={collection ? decodeURIComponent(collection) : null}
    />
  );
}

function BrainsOverview(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
      <div>
        <Brain className="mx-auto mb-3 h-8 w-8" />
        <div className="font-medium text-foreground">Brain Explorer</div>
        <div className="mt-1 max-w-sm text-sm">
          Select a project to inspect its shared brain memory — objects, lists,
          and events organized by collection.
        </div>
      </div>
    </div>
  );
}

// ── Project Detail ───────────────────────────────────────────────

function BrainProjectDetail({
  repoRoot,
  encodedRepoRoot,
  selectedCollection,
}: {
  repoRoot: string;
  encodedRepoRoot: string;
  selectedCollection: string | null;
}): JSX.Element {
  const navigate = useNavigate();
  const { data: collections = [], isLoading: collectionsLoading } =
    useBrainCollections(repoRoot);
  const [search, setSearch] = useState("");

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3 md:px-6">
        <h2 className="truncate text-xl font-semibold">
          {repoBasename(repoRoot)}
        </h2>
        <div
          className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
          title={repoRoot}
        >
          {repoRoot}
        </div>
      </div>

      <div className="border-b border-border px-4 md:px-6">
        <div className="flex items-center gap-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
            <CollectionPill
              label="All"
              active={selectedCollection === null}
              onClick={() => navigate(`/automations/brains/${encodedRepoRoot}`)}
            />
            {collectionsLoading
              ? null
              : collections.map((col) => (
                  <CollectionPill
                    key={col.collection}
                    label={col.collection}
                    count={col.objectCount + col.listCount + col.eventCount}
                    active={selectedCollection === col.collection}
                    onClick={() =>
                      navigate(
                        `/automations/brains/${encodedRepoRoot}/${encodeURIComponent(col.collection)}`
                      )
                    }
                  />
                ))}
          </div>
          <div className="relative shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              className="h-8 w-40 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      <BrainCollectionView
        repoRoot={repoRoot}
        collection={selectedCollection}
        search={search}
      />
    </div>
  );
}

function CollectionPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
    >
      {label}
      {count !== undefined ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px]",
            active ? "bg-primary/20" : "bg-muted"
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

// ── Collection View ──────────────────────────────────────────────

function BrainCollectionView({
  repoRoot,
  collection,
  search,
}: {
  repoRoot: string;
  collection: string | null;
  search: string;
}): JSX.Element {
  const objectFilters = collection ? { collection } : { limit: 100 };
  const listFilters = collection ? { collection } : { limit: 100 };
  const eventFilters = collection ? { collection, limit: 100 } : { limit: 100 };

  const { data: objects = [], isLoading: objectsLoading } = useBrainObjects(
    repoRoot,
    objectFilters
  );
  const { data: lists = [], isLoading: listsLoading } = useBrainLists(
    repoRoot,
    listFilters
  );
  const { data: events = [], isLoading: eventsLoading } = useBrainEvents(
    repoRoot,
    eventFilters
  );

  const isLoading = objectsLoading || listsLoading || eventsLoading;

  const lowerSearch = search.toLowerCase();
  const filteredObjects = search
    ? objects.filter(
        (o) =>
          o.name.toLowerCase().includes(lowerSearch) ||
          o.collection.toLowerCase().includes(lowerSearch)
      )
    : objects;
  const filteredLists = search
    ? lists.filter(
        (l) =>
          l.name.toLowerCase().includes(lowerSearch) ||
          l.collection.toLowerCase().includes(lowerSearch)
      )
    : lists;
  const filteredEvents = search
    ? events.filter(
        (e) =>
          e.kind.toLowerCase().includes(lowerSearch) ||
          (e.subject?.toLowerCase().includes(lowerSearch) ?? false) ||
          e.collection.toLowerCase().includes(lowerSearch)
      )
    : events;

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (
    filteredObjects.length === 0 &&
    filteredLists.length === 0 &&
    filteredEvents.length === 0
  ) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8" />
          <div className="mt-4">
            {search
              ? "No brain data matches your filter."
              : "No brain data in this collection yet."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-5xl space-y-1 px-3 pt-4 pb-12 sm:px-5 md:px-8">
        <CollapsibleSection
          title="Objects"
          icon={Database}
          count={filteredObjects.length}
        >
          {filteredObjects.map((obj) => (
            <ProjectObjectCard
              key={`${obj.collection}/${obj.name}`}
              obj={obj}
            />
          ))}
        </CollapsibleSection>

        <CollapsibleSection
          title="Lists"
          icon={List}
          count={filteredLists.length}
        >
          {filteredLists.map((list) => (
            <ProjectListCard
              key={`${list.collection}/${list.name}`}
              list={list}
              repoRoot={repoRoot}
            />
          ))}
        </CollapsibleSection>

        <CollapsibleSection
          title="Events"
          icon={Radio}
          count={filteredEvents.length}
        >
          {filteredEvents.map((event) => (
            <ProjectEventCard key={event.id} event={event} />
          ))}
        </CollapsibleSection>
      </div>
    </ScrollArea>
  );
}

// ── Cards ────────────────────────────────────────────────────────

function AgentLink({ agentId }: { agentId: string }): JSX.Element {
  return (
    <Link
      to={`/agents/${agentId}`}
      className="font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
      title={agentId}
      onClick={(e) => e.stopPropagation()}
    >
      {agentId.slice(0, 12)}
    </Link>
  );
}

function ProjectObjectCard({ obj }: { obj: BrainObject }): JSX.Element {
  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-sky-950/50 px-1.5 py-0.5 font-mono text-sky-400 text-[10px] shrink-0">
            {obj.collection}
          </span>
          <span className="font-medium truncate">{obj.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            rev {obj.revision}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          <AgentLink agentId={obj.updatedByAgentId} />
          <CopyButton value={obj.value} />
          <RelativeTime iso={obj.updatedAt} />
        </div>
      </div>
      <div className="rounded bg-muted/30 px-2.5 py-2 overflow-x-auto">
        <KeyValueTable value={obj.value} />
      </div>
    </div>
  );
}

function ProjectListCard({
  list,
  repoRoot,
}: {
  list: BrainList;
  repoRoot: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { data } = useBrainListItems(
    expanded ? repoRoot : null,
    list.collection,
    list.name,
    { limit: 50, order: "asc" }
  );

  const items = data?.items ?? [];

  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 mb-2 text-left"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="rounded bg-violet-950/50 px-1.5 py-0.5 font-mono text-violet-400 text-[10px] shrink-0">
            {list.collection}
          </span>
          <span className="font-medium truncate">{list.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          <AgentLink agentId={list.updatedByAgentId} />
          <span>{list.itemCount} items</span>
          <RelativeTime iso={list.updatedAt} />
        </div>
      </button>
      {expanded && items.length > 0 ? (
        <div className="rounded bg-muted/30 overflow-hidden">
          {items.map((item) => (
            <div
              key={item.index}
              className="flex gap-2 px-2.5 py-1.5 text-xs font-mono border-b border-border/50 last:border-b-0 min-w-0"
            >
              <span className="text-muted-foreground shrink-0 w-4 text-right pt-px">
                {item.index}
              </span>
              <div className="flex-1 overflow-x-auto">
                <KeyValueTable value={item.value} />
              </div>
              <CopyButton value={item.value} className="shrink-0 mt-px" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectEventCard({ event }: { event: BrainEvent }): JSX.Element {
  const style = getKindStyle(event.kind);

  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0", style.dot)} />
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] shrink-0",
              style.badge
            )}
          >
            {event.kind}
          </span>
          <span className="rounded bg-sky-950/50 px-1.5 py-0.5 font-mono text-sky-400 text-[10px] shrink-0">
            {event.collection}
          </span>
          {event.subject ? (
            <span className="truncate text-muted-foreground">
              {event.subject}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          <AgentLink agentId={event.agentId} />
          <CopyButton value={event.value} />
          <RelativeTime iso={event.createdAt} />
        </div>
      </div>
      {event.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 mb-2">
          {event.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {event.value != null ? (
        <div className="rounded bg-muted/30 px-2.5 py-2 overflow-x-auto">
          <KeyValueTable value={event.value} />
        </div>
      ) : null}
    </div>
  );
}
