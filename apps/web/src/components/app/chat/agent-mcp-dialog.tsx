import type { AgentMcpInventoryResponse, McpServer } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  ChevronRight,
  Plug,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";

const states: Record<string, string> = {
  connected: "Connected",
  failed: "Connection failed",
  pending: "Connecting",
  starting: "Connecting",
  notStarted: "Not started",
  "needs-auth": "Sign-in needed",
  authenticationRequired: "Sign-in needed",
  disabled: "Disabled",
  cancelled: "Cancelled",
};
function needsSignIn(server: McpServer) {
  return ["needs-auth", "authenticationRequired"].includes(server.state);
}
function alphabetical(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
function statusIcon(server: McpServer) {
  if (needsSignIn(server)) return KeyRound;
  if (server.state === "failed" || server.toolsState === "error")
    return CircleAlert;
  if (server.state === "connected") return CheckCircle2;
  if (["pending", "starting"].includes(server.state)) return LoaderCircle;
  return Circle;
}
function status(server: McpServer) {
  const state = states[server.state] ?? "Unknown status";
  if (needsSignIn(server)) return state;
  const tools =
    server.toolsState === "known"
      ? `${server.tools!.length} tools`
      : server.toolsState === "error"
        ? "Tool discovery failed"
        : "Tools unknown";
  return `${state} · ${tools}`;
}

function stateColor(server: McpServer) {
  if (needsSignIn(server)) return "text-status-waiting";
  if (server.state === "failed" || server.toolsState === "error")
    return "text-status-blocked";
  if (server.state === "connected") return "text-status-working";
  if (["pending", "starting"].includes(server.state))
    return "text-status-waiting";
  return "text-muted-foreground";
}

export type McpInventoryControl = { open: () => void };

/** The keyed subtree keeps navigation and pending responses tied to the target child. */
export function AgentMcpDialog(props: {
  agentId: string;
  active: boolean;
  online: boolean;
  controlRef?: Ref<McpInventoryControl>;
}): JSX.Element {
  return <McpInventoryPopover key={props.agentId} {...props} />;
}
function McpInventoryPopover({
  agentId,
  active,
  online,
  controlRef,
}: {
  agentId: string;
  active: boolean;
  online: boolean;
  controlRef?: Ref<McpInventoryControl>;
}) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(
    controlRef,
    () => ({
      open: () => {
        if (online) setOpen(true);
      },
    }),
    [online]
  );
  useEffect(() => {
    if (!online) setOpen(false);
  }, [online]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [attention, setAttention] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) backButton.current?.focus({ preventScroll: true });
  }, [selected]);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const query = useQuery<AgentMcpInventoryResponse>({
    queryKey: ["agent-mcp-inventory", agentId],
    queryFn: ({ signal }) =>
      api(`/api/v1/agents/${encodeURIComponent(agentId)}/mcp-inventory`, {
        signal,
      }),
    enabled: active && online && open,
    staleTime: 0,
    retry: false,
  });
  const data =
    !query.isError && query.data?.agentId === agentId ? query.data : undefined;
  const servers = [
    ...(data?.status === "ok" ? (data.inventory?.servers ?? []) : []),
  ].sort(alphabetical);
  const server = servers.find((item) => item.name === selected);
  const visible = servers.filter(
    (item) =>
      item.name.toLowerCase().includes(search.toLowerCase()) &&
      (!attention || item.state !== "connected")
  );
  const tools = server?.tools ?? [];
  const visibleTools = tools
    .filter((tool) =>
      `${tool.name} ${tool.description ?? ""}`
        .toLowerCase()
        .includes(toolSearch.toLowerCase())
    )
    .sort(alphabetical);
  const attentionCount = servers.filter(
    (item) => item.state !== "connected"
  ).length;
  const message = query.isError
    ? "Could not read MCP inventory."
    : data?.status === "offline"
      ? "This agent is offline."
      : data?.status === "unsupported"
        ? "Inventory is unavailable in this agent’s current session."
        : data?.status === "timeout"
          ? "Inventory request timed out."
          : data?.status !== "ok"
            ? "Inventory is temporarily unavailable."
            : null;
  return (
    <Popover open={online && open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:ring-1 data-[state=open]:ring-ring/50 pointer-coarse:min-h-11"
          disabled={!online}
          title={online ? "MCP servers" : "Agent is offline"}
          aria-label="MCP servers"
        >
          <Plug className="h-3 w-3" /> MCP
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          if (window.matchMedia("(pointer: coarse)").matches) {
            event.preventDefault();
            content.current?.focus({ preventScroll: true });
          }
        }}
        side="top"
        align="end"
        collisionPadding={8}
        aria-label="MCP servers"
        className="w-[360px] max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] flex flex-col overflow-hidden rounded-sm border border-border bg-background p-2 font-mono"
      >
        <div className="mb-2 flex shrink-0 items-center justify-between border-b border-border px-1 pb-1 text-xs">
          <span className="font-medium">
            <span aria-hidden="true" className="mr-2 text-status-working">
              &gt;_
            </span>
            MCP servers{data?.status === "ok" ? ` · ${servers.length}` : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            aria-label="Refresh MCP inventory"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className={`h-3 w-3 ${query.isFetching && !query.isPending ? "animate-spin text-primary motion-reduce:animate-none" : ""}`}
            />
          </Button>
        </div>
        {query.isPending ? (
          <div className="min-h-0 overflow-hidden px-2 pb-5 pt-2">
            <p
              role="status"
              className="mb-4 flex items-center gap-2 text-xs text-primary"
            >
              <LoaderCircle
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
              Reading servers…
            </p>
            <div aria-hidden="true" className="space-y-1">
              {["w-32", "w-24", "w-36", "w-28"].map((width) => (
                <div
                  key={width}
                  className="flex h-11 items-center gap-2 border-b border-border/50"
                >
                  <Skeleton className="h-3.5 w-3.5 rounded-full motion-reduce:animate-none" />
                  <Skeleton
                    className={`h-3 ${width} motion-reduce:animate-none`}
                  />
                  <Skeleton className="ml-auto h-3 w-12 motion-reduce:animate-none" />
                </div>
              ))}
            </div>
          </div>
        ) : message ? (
          <p role="status" className="px-1 py-3 text-xs text-muted-foreground">
            {message}
          </p>
        ) : server ? (
          <div className="flex min-h-0 flex-col overflow-hidden">
            <div className="mb-2 flex shrink-0 items-center gap-2">
              <Button
                ref={backButton}
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-1 text-[11px] text-foreground hover:bg-transparent pointer-coarse:min-h-11"
                onClick={() => {
                  setSelected(null);
                  requestAnimationFrame(() =>
                    rows.current.get(server.name)?.focus()
                  );
                }}
              >
                <span className="inline-flex h-6 items-center rounded border border-foreground/30 bg-accent px-2">
                  Back
                </span>
              </Button>
              <div className="min-w-0">
                <p className="break-words text-xs font-medium">{server.name}</p>
                <p className={`text-[11px] ${stateColor(server)}`}>
                  {status(server)}
                </p>
              </div>
            </div>
            <Input
              aria-label={`Search ${server.name} tools`}
              placeholder="Search tools…"
              value={toolSearch}
              onChange={(event) => setToolSearch(event.target.value)}
              className="mb-1 h-8 shrink-0 rounded-sm text-xs pointer-coarse:min-h-11 pointer-coarse:text-base"
            />
            <div
              className="min-h-0 max-h-[min(256px,45dvh)] overflow-y-auto overscroll-contain touch-pan-y"
              aria-label={`${server.name} tools`}
            >
              {needsSignIn(server) &&
              server.toolsState !== "known" ? null : server.toolsState !==
                "known" ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  {server.toolsState === "error"
                    ? "Tool discovery failed."
                    : "Tools are not available yet."}
                </p>
              ) : (
                <>
                  {visibleTools.map((tool) => (
                    <div key={tool.name}>
                      {tool.description ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto min-h-8 w-full justify-start whitespace-normal break-all px-1 text-left text-xs font-normal pointer-coarse:min-h-11"
                          aria-expanded={expanded === tool.name}
                          onClick={() =>
                            setExpanded(
                              expanded === tool.name ? null : tool.name
                            )
                          }
                        >
                          <ChevronRight
                            aria-hidden="true"
                            className={`mr-1 h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded === tool.name ? "rotate-90" : ""}`}
                          />
                          {tool.name}
                        </Button>
                      ) : (
                        <p className="break-all px-1 py-2 text-xs">
                          {tool.name}
                        </p>
                      )}
                      {expanded === tool.name && tool.description ? (
                        <p className="whitespace-pre-wrap break-words px-1 pb-2 text-[11px] text-muted-foreground">
                          {tool.description}
                        </p>
                      ) : null}
                    </div>
                  ))}
                  {!visibleTools.length ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      {tools.length ? "No tools match." : "No tools reported."}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
              <Input
                aria-label="Search MCP servers"
                placeholder="Search servers…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-8 rounded-sm pl-7 text-xs pointer-coarse:min-h-11 pointer-coarse:text-base"
              />
            </div>
            {attention || attentionCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={attention}
                className="my-1 h-7 shrink-0 self-start px-1 text-[11px] text-status-waiting pointer-coarse:min-h-11"
                onClick={() => setAttention(!attention)}
              >
                Needs attention · {attentionCount}
              </Button>
            ) : null}
            <div
              className="mt-1 min-h-0 max-h-[min(320px,50dvh)] overflow-y-auto overscroll-contain touch-pan-y"
              aria-label="MCP server list"
            >
              {visible.map((item) => {
                const StatusIcon = statusIcon(item);
                return (
                  <Button
                    key={item.name}
                    aria-label={`${item.name} ${status(item)}`}
                    title={status(item)}
                    ref={(element) => {
                      if (element) rows.current.set(item.name, element);
                      else rows.current.delete(item.name);
                    }}
                    type="button"
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 rounded-none border-b border-border/50 px-2 text-left font-normal pointer-coarse:min-h-11"
                    onClick={() => {
                      setSelected(item.name);
                      setToolSearch("");
                      setExpanded(null);
                    }}
                  >
                    <StatusIcon
                      aria-hidden="true"
                      className={`h-3.5 w-3.5 shrink-0 ${stateColor(item)}`}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-xs"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    {!needsSignIn(item) && item.toolsState === "known" ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {item.tools!.length} tools
                      </span>
                    ) : null}
                  </Button>
                );
              })}
              {!visible.length ? (
                <p className="px-1 py-3 text-xs text-muted-foreground">
                  {servers.length
                    ? "No servers match."
                    : "No MCP servers reported."}
                </p>
              ) : null}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
