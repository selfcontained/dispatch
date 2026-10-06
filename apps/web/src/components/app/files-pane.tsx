import { useAtom } from "jotai";
import { filesBrowserStateFamily } from "./files-browser-state";
import { FilesTextPreview } from "./files-text-preview";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Split,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { FileActions } from "./file-lightbox-actions";
import { cn } from "@/lib/utils";

type Entry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "link" | "other";
};
type FileIndex = {
  paths: string[];
  truncated: boolean;
  source: "git" | "folders";
};
type Listing = { entries: Entry[]; truncated: boolean };
type Preview = { size: number } & (
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | { kind: "unsupported"; message: string }
);
type Row =
  | { entry: Entry; depth: number }
  | { message: string; depth: number; retry?: string };
const queryOptions = {
  staleTime: Infinity,
  gcTime: 30_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

/** A fixed-height viewport for directory rows. No recursive DOM tree is mounted. */
function WindowedRows({
  count,
  rowHeight,
  render,
  label,
  rowKeys,
  initialTop,
  onSaveTop,
  onActivate,
  onBranchKey,
}: {
  count: number;
  rowHeight: number;
  render: (index: number, active: boolean, id: string) => ReactNode;
  label: string;
  rowKeys: (string | null)[];
  initialTop: number;
  onSaveTop: (top: number) => void;
  onActivate: (index: number) => void;
  onBranchKey: (index: number, key: string) => number | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: initialTop, height: 600 });
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = Math.max(
    0,
    rowKeys.indexOf(activeKey) >= 0 && activeKey !== null
      ? rowKeys.indexOf(activeKey)
      : rowKeys.findIndex(Boolean)
  );
  const idPrefix = useId();
  const saved = useRef(initialTop);
  const save = useRef(onSaveTop);
  save.current = onSaveTop;
  const restore = useRef<number | null>(initialTop);
  useEffect(() => () => save.current(saved.current), []);
  useLayoutEffect(() => {
    restore.current = initialTop;
    saved.current = initialTop;
  }, [initialTop]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || restore.current === null) return;
    element.scrollTop = restore.current;
    setViewport((v) => ({ ...v, top: element.scrollTop }));
    if (element.scrollHeight - element.clientHeight >= restore.current)
      restore.current = null;
  }, [count, initialTop]);
  function focusRow(index: number) {
    const key = rowKeys[index];
    if (!key) return;
    restore.current = null;
    setActiveKey(key);
    const element = ref.current!;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
    setViewport((v) => ({ ...v, top: element.scrollTop }));
  }
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport((v) => ({ ...v, height: element.clientHeight }))
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = Math.min(
    Math.max(0, count - 1),
    Math.max(0, Math.floor(viewport.top / rowHeight) - 5)
  );
  const end = Math.min(
    count,
    first + Math.ceil(viewport.height / rowHeight) + 10
  );
  return (
    <div
      ref={ref}
      aria-label={label}
      role="tree"
      tabIndex={0}
      aria-activedescendant={
        rowKeys[active] ? `${idPrefix}-${active}` : undefined
      }
      onWheel={() => {
        restore.current = null;
      }}
      onTouchStart={() => {
        restore.current = null;
      }}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest("[data-file-row]");
        if (row) {
          const index = Number(row.getAttribute("data-file-row"));
          setActiveKey(rowKeys[index] ?? null);
          ref.current?.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const key = event.key;
        if (
          [
            "ArrowDown",
            "ArrowUp",
            "Home",
            "End",
            "PageDown",
            "PageUp",
          ].includes(key)
        ) {
          event.preventDefault();
          const direction =
            key === "ArrowUp" || key === "PageUp" || key === "End" ? -1 : 1;
          let target =
            key === "Home"
              ? 0
              : key === "End"
                ? count - 1
                : Math.max(
                    0,
                    Math.min(
                      count - 1,
                      active +
                        direction *
                          (key.startsWith("Page")
                            ? Math.max(
                                1,
                                Math.floor(viewport.height / rowHeight)
                              )
                            : 1)
                    )
                  );
          while (target >= 0 && target < count && !rowKeys[target])
            target += direction;
          if (target >= 0 && target < count) focusRow(target);
        } else if (key === "Enter" || key === " ") {
          event.preventDefault();
          if (rowKeys[active]) onActivate(active);
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
          event.preventDefault();
          const target = onBranchKey(active, key);
          if (target !== undefined) focusRow(target);
        }
      }}
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-x-none touch-pan-y"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        if (restore.current === null) saved.current = top;
        setViewport((v) => ({ ...v, top }));
      }}
    >
      <div
        style={{
          height: count * rowHeight,
          position: "relative",
          minWidth: "100%",
        }}
      >
        {[
          ...new Set([
            ...Array.from(
              { length: end - first },
              (_, offset) => first + offset
            ),
            ...(rowKeys[active] ? [active] : []),
          ]),
        ].map((index) => {
          return (
            <div
              key={index}
              style={{
                position: "absolute",
                top: index * rowHeight,
                height: rowHeight,
                width: "100%",
              }}
            >
              {render(index, index === active, `${idPrefix}-${index}`)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FilesPane({
  agentId,
  workspace,
  onOpenBeside,
  isSplit,
  isMobile,
}: {
  agentId: string | null;
  workspace: string | null;
  onOpenBeside: () => void;
  isSplit: boolean;
  isMobile: boolean;
}) {
  if (!agentId || !workspace)
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        Select an agent with a workspace to browse files.
      </div>
    );
  return (
    <WorkspaceFiles
      agentId={agentId}
      workspace={workspace}
      onOpenBeside={onOpenBeside}
      isSplit={isSplit}
      isMobile={isMobile}
    />
  );
}

function WorkspaceFiles({
  agentId,
  workspace,
  onOpenBeside,
  isSplit,
  isMobile,
}: {
  agentId: string;
  workspace: string;
  onOpenBeside: () => void;
  isSplit: boolean;
  isMobile: boolean;
}) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get("files.path") ?? params.get("path") ?? "";
  const [browserState, setBrowserState] = useAtom(
    filesBrowserStateFamily(JSON.stringify([agentId, workspace]))
  );
  const { expanded, filter } = browserState;
  const setExpanded = (update: (old: string[]) => string[]) =>
    setBrowserState((old) => ({ ...old, expanded: update(old.expanded) }));
  const setFilter = (filter: string) =>
    setBrowserState((old) => ({ ...old, filter, searchTop: 0 }));
  const browse = browserState.browse ?? !selected;
  const setBrowse = (browse: boolean) =>
    setBrowserState((old) => ({ ...old, browse }));
  const indexGeneration = useRef("initial");
  const [search, setSearch] = useState(filter.trim().toLowerCase());
  useEffect(() => {
    const timer = setTimeout(() => setSearch(filter.trim().toLowerCase()), 180);
    return () => clearTimeout(timer);
  }, [filter]);
  const panel = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(isMobile);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth < 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const prefix = useMemo(
    () => ["workspace-files", agentId, workspace],
    [agentId, workspace]
  );
  const url = (path: string, file = false) =>
    `/api/v1/agents/${encodeURIComponent(agentId)}/workspace?${new URLSearchParams({ workspace, path, file: String(file) })}`;
  const listings = useQueries({
    queries: expanded.map((path) => ({
      queryKey: [...prefix, "directory", path],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<Listing>(url(path), { signal }),
      ...queryOptions,
    })),
  });
  const preview = useQuery({
    queryKey: [...prefix, "file", selected],
    queryFn: ({ signal }) => api<Preview>(url(selected, true), { signal }),
    enabled: !!selected,
    ...queryOptions,
  });
  const fileIndex = useQuery({
    queryKey: [...prefix, "index"],
    queryFn: ({ signal }) =>
      api<FileIndex>(
        url("") + "&index=true&generation=" + indexGeneration.current,
        { signal }
      ),
    enabled: !!search,
    ...queryOptions,
  });
  const matches = useMemo(() => {
    if (!search) return [];
    const rank = (p: string) => {
      const name = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
      return name === search
        ? 0
        : name.startsWith(search)
          ? 1
          : name.includes(search)
            ? 2
            : 3;
    };
    return (fileIndex.data?.paths ?? [])
      .filter((p) => p.toLowerCase().includes(search))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [fileIndex.data, search]);
  const listingMap = new Map(
    expanded.map((path, index) => [path, listings[index]!])
  );
  const rows: Row[] = [];
  function append(directory: string, depth: number) {
    const query = listingMap.get(directory);
    if (!query) return;
    if (query.isPending) {
      rows.push({ depth, message: "Loading…" });
      return;
    }
    if (query.isError) {
      rows.push({ depth, message: query.error.message, retry: directory });
      return;
    }
    if (!query.data) return;
    for (const entry of query.data.entries) {
      rows.push({ depth, entry });
      if (entry.kind === "directory" && expanded.includes(entry.path))
        append(entry.path, depth + 1);
    }
    if (query.data.truncated)
      rows.push({
        depth,
        message: "Listing incomplete · up to 500 visible entries",
      });
    if (!query.data.entries.length)
      rows.push({ depth, message: "Empty folder" });
  }
  append("", 0);
  if (search) {
    rows.length = 0;
    if (fileIndex.isPending)
      rows.push({ depth: 0, message: "Finding filenames…" });
    else if (fileIndex.isError)
      rows.push({ depth: 0, message: fileIndex.error.message, retry: "index" });
    else
      for (const path of matches.slice(0, 200))
        rows.push({
          depth: 0,
          entry: {
            name: path.slice(path.lastIndexOf("/") + 1),
            path,
            kind: "file",
          },
        });
  }
  const refreshing =
    fileIndex.isFetching ||
    listings.some((query) => query.isFetching) ||
    preview.isFetching;
  const choose = (entry: Entry) => {
    if (entry.kind === "directory") {
      setExpanded((old) =>
        old.includes(entry.path)
          ? old.filter(
              (p) => p !== entry.path && !p.startsWith(`${entry.path}/`)
            )
          : old.length >= 32
            ? (toast.info(
                "Close a folder before opening more (32-folder MVP limit)."
              ),
              old)
            : [...old, entry.path]
      );
    } else if (entry.kind === "file") {
      setParams((old) => {
        const next = new URLSearchParams(old);
        next.delete("path");
        next.delete("line");
        next.set("files.path", entry.path);
        return next;
      });
      setBrowse(false);
    }
  };
  return (
    <div
      ref={panel}
      data-testid="files-pane"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={workspace}>
            {workspace.split("/").filter(Boolean).at(-1)}
          </div>
          <div
            className="truncate text-[10px] text-muted-foreground"
            title={workspace}
          >
            {workspace}
          </div>
        </div>
        {!isSplit && !isMobile && (
          <Button
            title="Open beside Agent"
            aria-label="Open beside Agent"
            variant="ghost"
            size="icon"
            onClick={onOpenBeside}
          >
            <Split className="h-4 w-4" />
          </Button>
        )}
        <Button
          title="Refresh files and preview"
          aria-label="Refresh files and preview"
          variant="ghost"
          size="icon"
          disabled={refreshing}
          onClick={() => {
            indexGeneration.current = String(Date.now());
            void queryClient.invalidateQueries({ queryKey: prefix });
          }}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {(!narrow || browse || !selected) && (
          <div
            className={cn(
              "flex min-h-0 flex-col border-r",
              narrow ? "w-full" : "w-60 shrink-0"
            )}
          >
            <div className="relative m-2">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                aria-label="Find files"
                placeholder="Find files…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 pl-7 text-xs"
              />
            </div>
            {search && fileIndex.data && (
              <p className="px-3 pb-2 text-[10px] text-muted-foreground">
                {matches.length > 200 ? "First 200 of " : ""}
                {matches.length} matches
                {fileIndex.data.truncated ? " · Partial index" : ""}
                {" · "}
                {fileIndex.data.source === "git"
                  ? "Git-ignored files excluded"
                  : "Dependency/build folders excluded"}
              </p>
            )}
            <WindowedRows
              key={search || "tree"}
              count={rows.length}
              rowHeight={search ? 44 : 32}
              label={search ? "Matching files" : "Workspace files"}
              rowKeys={rows.map((row) =>
                "entry" in row &&
                (row.entry.kind === "file" || row.entry.kind === "directory")
                  ? row.entry.path
                  : null
              )}
              initialTop={
                search ? browserState.searchTop : browserState.treeTop
              }
              onSaveTop={(top) =>
                setBrowserState((old) => ({
                  ...old,
                  [search ? "searchTop" : "treeTop"]:
                    search && old.filter.trim().toLowerCase() !== search
                      ? old.searchTop
                      : top,
                }))
              }
              onActivate={(index) => {
                const row = rows[index];
                if (row && "entry" in row) choose(row.entry);
              }}
              onBranchKey={(index, key) => {
                const row = rows[index];
                if (!row || !("entry" in row)) return;
                const open = expanded.includes(row.entry.path);
                if (key === "ArrowRight") {
                  if (row.entry.kind === "directory" && !open)
                    choose(row.entry);
                  else if (rows[index + 1]?.depth > row.depth) return index + 1;
                } else if (row.entry.kind === "directory" && open)
                  choose(row.entry);
                else if (!search) {
                  for (let parent = index - 1; parent >= 0; parent--)
                    if (
                      rows[parent]!.depth < row.depth &&
                      "entry" in rows[parent]!
                    )
                      return parent;
                }
              }}
              render={(index, active, id) => {
                const row = rows[index]!;
                if (!("entry" in row))
                  return (
                    <div
                      className="flex h-full items-center gap-1 truncate px-3 text-[11px] text-muted-foreground"
                      title={row.message}
                    >
                      {row.message}
                      {row.retry !== undefined && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void (search
                              ? fileIndex.refetch()
                              : listingMap.get(row.retry!)?.refetch())
                          }
                        >
                          Retry
                        </Button>
                      )}
                    </div>
                  );
                const { entry, depth } = row;
                const open = expanded.includes(entry.path);
                return (
                  <button
                    type="button"
                    id={id}
                    role="treeitem"
                    tabIndex={-1}
                    data-file-row={index}
                    aria-level={depth + 1}
                    aria-label={
                      search ? `${entry.name} ${entry.path}` : entry.name
                    }
                    aria-selected={selected === entry.path}
                    title={entry.path}
                    aria-expanded={
                      entry.kind === "directory" ? open : undefined
                    }
                    disabled={entry.kind === "link" || entry.kind === "other"}
                    onClick={() => choose(entry)}
                    className={cn(
                      "relative flex h-full w-full items-center gap-1.5 pr-3 text-left text-xs hover:bg-muted/60 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary disabled:opacity-40",
                      selected === entry.path && "bg-primary/10 text-primary",
                      active && "ring-1 ring-inset ring-border"
                    )}
                    style={{ paddingLeft: 10 + depth * 8 }}
                  >
                    {Array.from({ length: depth }, (_, level) => (
                      <span
                        key={level}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 border-l border-border/50"
                        style={{ left: 15 + level * 8 }}
                      />
                    ))}
                    {entry.kind === "directory" ? (
                      <>
                        {open ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </>
                    ) : (
                      <File className="ml-4 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span aria-hidden="true" className="flex min-w-0">
                        <span className="truncate">
                          {entry.name.slice(
                            0,
                            Math.max(0, entry.name.length - 8)
                          )}
                        </span>
                        <span className="shrink-0">
                          {entry.name.slice(-8)}
                          {entry.kind === "link" ? " ↗" : ""}
                        </span>
                      </span>
                      {search && (
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {entry.path}
                        </span>
                      )}
                    </span>
                  </button>
                );
              }}
            />
            {!rows.length && (
              <p className="p-3 text-xs text-muted-foreground">
                No filenames match.
              </p>
            )}
            <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
              On-demand · Manual refresh · No background scans
            </div>
          </div>
        )}
        {(!narrow || (!browse && selected)) && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
                  {narrow && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Browse files"
                      onClick={() => setBrowse(true)}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                  )}
                  <span
                    className="min-w-0 flex-1 truncate px-1 font-mono text-xs"
                    title={selected}
                  >
                    {selected}
                  </span>
                  {preview.data && (
                    <WorkspaceFileActions
                      key={selected}
                      preview={preview.data}
                      fileName={selected.split("/").at(-1)!}
                    />
                  )}
                </div>
                {preview.isPending ? (
                  <div className="p-6 text-sm text-muted-foreground">
                    Loading preview…
                  </div>
                ) : preview.isError ? (
                  <div
                    role="alert"
                    className="p-6 text-sm text-muted-foreground"
                  >
                    {preview.error.message}
                    <Button
                      className="ml-2"
                      size="sm"
                      onClick={() => void preview.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : preview.data?.kind === "text" ? (
                  <FilesTextPreview
                    key={selected}
                    text={preview.data.text}
                    fileName={selected}
                  />
                ) : preview.data?.kind === "image" ? (
                  <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
                    <img
                      src={preview.data.src}
                      alt={selected}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    {preview.data?.kind === "unsupported" &&
                      preview.data.message}
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
                <File className="h-10 w-10 opacity-30" />
                <p className="text-sm">Select a file to preview</p>
                <p className="max-w-64 text-xs leading-relaxed">
                  Browse the agent’s workspace. Folders load only when opened;
                  files stay on disk until selected.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Reuse the lightbox actions with already-loaded bytes: copying/downloading
// never causes a second workspace read.
function WorkspaceFileActions({
  preview,
  fileName,
}: {
  preview: Preview;
  fileName: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string>();
  useEffect(() => {
    if (preview.kind !== "text") {
      setBlobUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([preview.text], { type: "text/plain;charset=utf-8" })
    );
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  const src = preview.kind === "image" ? preview.src : blobUrl;
  if (preview.kind === "unsupported" || !src) return null;
  return (
    <FileActions
      src={src}
      fileName={fileName}
      downloadName={fileName}
      isText={preview.kind === "text"}
      textContent={preview.kind === "text" ? preview.text : undefined}
    />
  );
}
