import type { AgentMcpInventoryResponse, McpServer } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plug, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
function status(server: McpServer) {
  const state = states[server.state] ?? "Unknown status";
  const tools =
    server.toolsState === "known"
      ? `${server.tools!.length} tools`
      : server.toolsState === "error"
        ? "Tool discovery failed"
        : "Tools unknown";
  return `${state} · ${tools}`;
}

function stateColor(server: McpServer) {
  if (server.state === "failed" || server.toolsState === "error")
    return "text-status-blocked";
  if (server.state === "connected") return "text-status-working";
  if (
    ["needs-auth", "authenticationRequired", "pending", "starting"].includes(
      server.state
    )
  )
    return "text-status-waiting";
  return "text-muted-foreground";
}

/** The keyed subtree keeps navigation and pending responses tied to the target child. */
export function AgentMcpDialog(props: {
  agentId: string;
  active: boolean;
}): JSX.Element {
  return <McpInventoryPopover key={props.agentId} {...props} />;
}
function McpInventoryPopover({
  agentId,
  active,
}: {
  agentId: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [attention, setAttention] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
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
    enabled: active && open,
    staleTime: 0,
    retry: false,
  });
  const data =
    !query.isError && query.data?.agentId === agentId ? query.data : undefined;
  const servers = data?.status === "ok" ? (data.inventory?.servers ?? []) : [];
  const server = servers.find((item) => item.name === selected);
  const visible = servers.filter(
    (item) =>
      item.name.toLowerCase().includes(search.toLowerCase()) &&
      (!attention || item.state !== "connected")
  );
  const message = query.isPending
    ? "Loading MCP servers…"
    : query.isError
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground pointer-coarse:min-h-11"
          aria-label="MCP servers"
        >
          <Plug className="h-3 w-3" /> MCP
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={8}
        aria-label="MCP servers"
        className="w-[360px] max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain touch-pan-y rounded-sm border border-border bg-background p-2 font-mono"
      >
        <div className="mb-2 flex items-center justify-between border-b border-border px-1 pb-1 text-xs">
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
              className={`h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
        {message ? (
          <p role="status" className="px-1 py-3 text-xs text-muted-foreground">
            {message}
          </p>
        ) : server ? (
          <div>
            <div className="mb-2 flex items-center gap-2">
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
              className="mb-1 h-8 rounded-sm text-xs pointer-coarse:min-h-11 pointer-coarse:text-base"
            />
            <div
              className="max-h-[min(256px,45dvh)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]"
              aria-label={`${server.name} tools`}
            >
              {server.toolsState !== "known" ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  {server.toolsState === "error"
                    ? "Tool discovery failed."
                    : "Tools are not available yet."}
                </p>
              ) : (
                <>
                  {server
                    .tools!.filter((tool) =>
                      `${tool.name} ${tool.description ?? ""}`
                        .toLowerCase()
                        .includes(toolSearch.toLowerCase())
                    )
                    .map((tool) => (
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
                  {!server.tools!.length ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No tools reported.
                    </p>
                  ) : !server.tools!.some((tool) =>
                      `${tool.name} ${tool.description ?? ""}`
                        .toLowerCase()
                        .includes(toolSearch.toLowerCase())
                    ) ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No tools match.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
              <Input
                aria-label="Search MCP servers"
                placeholder="Search servers…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-8 rounded-sm pl-7 text-xs pointer-coarse:min-h-11 pointer-coarse:text-base"
              />
            </div>
            {attention || servers.some((item) => item.state !== "connected") ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={attention}
                className="my-1 h-7 px-1 text-[11px] text-status-waiting pointer-coarse:min-h-11"
                onClick={() => setAttention(!attention)}
              >
                Needs attention ·{" "}
                {servers.filter((item) => item.state !== "connected").length}
              </Button>
            ) : null}
            <div
              className="mt-1 max-h-[min(320px,50dvh)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]"
              aria-label="MCP server list"
            >
              {visible.map((item) => (
                <Button
                  key={item.name}
                  aria-label={`${item.name} ${status(item)}`}
                  ref={(element) => {
                    if (element) rows.current.set(item.name, element);
                    else rows.current.delete(item.name);
                  }}
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-11 w-full flex-col items-start gap-0.5 whitespace-normal rounded-none border-b border-border/50 px-2 py-2 text-left font-normal"
                  onClick={() => {
                    setSelected(item.name);
                    setToolSearch("");
                    setExpanded(null);
                  }}
                >
                  <span className="flex items-center gap-2 text-xs">
                    <span aria-hidden="true" className={stateColor(item)}>
                      ●
                    </span>
                    <span className="break-all">{item.name}</span>
                  </span>
                  <span className={`pl-4 text-[11px] ${stateColor(item)}`}>
                    {status(item)}
                  </span>
                </Button>
              ))}
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
