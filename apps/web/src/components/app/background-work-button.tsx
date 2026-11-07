import { conversationLocation } from "./chat/conversation-location-link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Info,
  Pause,
  Radio,
  Square,
  Terminal,
  WifiOff,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { BackgroundItem, BackgroundSnapshot } from "@dispatch/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const terminal = (item: BackgroundItem) =>
  ["completed", "failed", "stopped"].includes(item.state ?? "");
const stateLabel = (item: BackgroundItem) =>
  item.stale && !terminal(item)
    ? `Last reported ${item.state ?? "unknown"} · stale`
    : (item.state ?? "unknown");
const providerLabel = (item: BackgroundItem) =>
  item.provider === "claude" ? "Claude" : "Codex";
const reportTime = (item: BackgroundItem) =>
  new Date(item.lastObservation).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

function WorkStatus({ item }: { item: BackgroundItem }) {
  const uncertain = item.stale && !terminal(item);
  const Icon =
    uncertain || !item.state
      ? Clock3
      : item.state === "running"
        ? Activity
        : item.state === "paused"
          ? Pause
          : item.state === "completed"
            ? Check
            : item.state === "failed"
              ? CircleAlert
              : Square;
  const color =
    uncertain || item.state === "paused"
      ? "border-status-waiting/30 bg-status-waiting/10 text-status-waiting [[data-theme-mode=light]_&]:text-amber-800"
      : item.state === "running"
        ? "border-status-working/30 bg-status-working/10 text-status-working [[data-theme-mode=light]_&]:text-emerald-800"
        : item.state === "completed"
          ? "border-status-done/30 bg-status-done/10 text-status-done [[data-theme-mode=light]_&]:text-sky-800"
          : item.state === "failed"
            ? "border-status-blocked/30 bg-status-blocked/10 text-status-blocked [[data-theme-mode=light]_&]:text-red-800"
            : "border-border bg-muted/60 text-muted-foreground";
  return (
    <Badge
      className={cn("shrink-0 gap-1.5 normal-case tracking-normal", color)}
    >
      <Icon className="size-3" aria-hidden="true" />
      {stateLabel(item)}
    </Badge>
  );
}
function WorkIcon({ item }: { item: BackgroundItem }) {
  const Icon =
    item.taskType === "monitor"
      ? Radio
      : item.taskType === "turn"
        ? Activity
        : Terminal;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-status-reviewing/15 bg-status-reviewing/10 text-status-reviewing">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}
export function BackgroundWorkButton({
  agentId,
  archived = false,
}: {
  agentId: string | null;
  archived?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["background-work", agentId],
    queryFn: () =>
      api<BackgroundSnapshot>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/background-work`
      ),
    enabled: !!agentId,
    refetchInterval: open ? 2000 : 10000,
  });
  const detailQuery = useQuery({
    queryKey: ["background-work-detail", agentId, selected],
    queryFn: () =>
      api<BackgroundSnapshot>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/background-work?detail=${encodeURIComponent(selected!)}`
      ),
    enabled: !!agentId && !!selected && open,
    refetchInterval: open ? 2000 : false,
  });
  if (!agentId) return null;
  const snapshot = query.data;
  const items = (snapshot?.items ?? []).map((item) =>
    query.isError ? { ...item, stale: true } : item
  );
  const active = items.filter((item) => !terminal(item));
  const knownCount = active.filter(
    (item) => item.state === "running" || item.state === "paused"
  ).length;
  const stale =
    query.isError || snapshot?.stale || active.some((item) => item.stale);
  const listed = items.find(
    (item) => `${item.generation}:${item.id}` === selected
  );
  const detailed = detailQuery.data?.items.find(
    (item) => `${item.generation}:${item.id}` === selected
  );
  const latest =
    detailed && (!listed || detailed.sequence > listed.sequence)
      ? detailed
      : listed;
  const current = latest
    ? {
        ...latest,
        stale: latest.stale || query.isError,
        terminalOutput: detailQuery.isError
          ? undefined
          : detailed?.terminalOutput,
      }
    : detailed
      ? { ...detailed, stale: true, terminalOutput: undefined }
      : undefined;
  const running = active.filter(
    (item) => item.state === "running" && !item.stale
  ).length;
  const paused = active.filter(
    (item) => item.state === "paused" && !item.stale
  ).length;
  const uncertain = active.filter((item) => item.stale || !item.state).length;
  const finished = items.filter(terminal);
  const renderRow = (item: BackgroundItem) => (
    <button
      key={`${item.generation}:${item.id}`}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-muted/15 p-3 text-left text-foreground transition-colors hover:border-status-reviewing/35 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setSelected(`${item.generation}:${item.id}`)}
    >
      <WorkIcon item={item} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <span className="min-w-0 line-clamp-2 break-words text-sm font-semibold">
            {item.name || "Reported background work"}
          </span>
          <WorkStatus item={item} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{providerLabel(item)}</span>
          <span aria-hidden="true">·</span>
          <span className="max-w-36 truncate capitalize">
            {item.taskType ?? "Unknown type"}
          </span>
          <span
            className="ml-auto flex items-center gap-1"
            title={new Date(item.lastObservation).toLocaleString()}
          >
            <Clock3 className="size-3" aria-hidden="true" />
            {reportTime(item)}
          </span>
        </div>
      </div>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </button>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setSelected(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          aria-label={`Background work${knownCount ? ` ${knownCount}` : ""}${stale ? " · stale" : ""}`}
        >
          <Activity className="size-3.5" />
          <span className="hidden sm:inline">Background work</span>
          <span className="sm:hidden">Work</span>
          {knownCount > 0 && (
            <span className="flex min-w-4 items-center justify-center rounded bg-muted px-1 text-[11px] tabular-nums">
              {knownCount}
            </span>
          )}
          {stale && (
            <span
              className="size-1.5 rounded-full bg-amber-500"
              title="Some observations are stale"
            />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[min(640px,calc(100vw-2rem))] gap-0 p-0 font-sans text-foreground max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:max-h-[90dvh] max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-status-reviewing/15 text-status-reviewing">
              <Activity className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-semibold">
                Background work
              </DialogTitle>
              <DialogDescription className="sr-only">
                Read-only reports from your agent. Idle does not mean background
                work has ended.
              </DialogDescription>
              <span className="text-xs text-muted-foreground">
                {current ? "Work details" : "Agent-reported activity"}
              </span>
            </div>
            <Badge className="normal-case tracking-normal">Read only</Badge>
            <DialogClose asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Close background work"
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          {(query.isError || snapshot?.stale) && (
            <div
              role={query.isError ? "alert" : undefined}
              className="flex items-center gap-2 rounded-lg border border-status-waiting/25 bg-status-waiting/10 px-3 py-2 text-xs text-status-waiting [[data-theme-mode=light]_&]:text-amber-800"
            >
              <WifiOff className="size-4 shrink-0" />
              <span>
                <strong className="font-medium">Updates unavailable.</strong>{" "}
                Showing last reported states.
              </span>
            </div>
          )}
          {snapshot?.identityOverflow && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-status-waiting/25 bg-status-waiting/10 px-3 py-2 text-xs text-status-waiting [[data-theme-mode=light]_&]:text-amber-800"
            >
              <CircleAlert className="size-4 shrink-0" />
              Tracking capacity reached. New work may be unavailable.
            </div>
          )}
          {query.isPending && (
            <div className="space-y-3" aria-label="Loading reported work">
              {[0, 1].map((key) => (
                <div
                  key={key}
                  className="h-20 animate-pulse rounded-xl bg-muted/50"
                />
              ))}
            </div>
          )}
          {current ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-7 gap-1.5 text-xs text-muted-foreground"
                aria-label="Back to reported work"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft className="size-3.5" />
                All work
              </Button>
              <div className="flex items-start gap-3">
                <WorkIcon item={current} />
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-base font-semibold leading-snug">
                    {current.name || "Reported background work"}
                  </h3>
                  <div className="mt-2">
                    <WorkStatus item={current} />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/60 bg-border/50">
                <div className="bg-card p-3">
                  <div className="mb-1 text-[11px] text-muted-foreground">
                    Reported by
                  </div>
                  <div className="text-sm font-medium">
                    {providerLabel(current)}
                  </div>
                </div>
                <div className="bg-card p-3">
                  <div className="mb-1 text-[11px] text-muted-foreground">
                    Work type
                  </div>
                  <div className="break-words text-sm font-medium capitalize">
                    {current.taskType ?? "Unknown"}
                  </div>
                </div>
                <div className="bg-card p-3">
                  <div className="mb-1 text-[11px] text-muted-foreground">
                    Last report
                  </div>
                  <time
                    className="text-sm font-medium"
                    dateTime={current.lastObservation}
                    title={new Date(current.lastObservation).toLocaleString()}
                  >
                    {new Date(current.lastObservation).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · {reportTime(current)}
                  </time>
                </div>
                <div className="bg-card p-3">
                  <div className="mb-1 text-[11px] text-muted-foreground">
                    Origin
                  </div>
                  {current.originBlockId ? (
                    <Link
                      className="inline-flex items-center gap-1 text-sm font-medium text-status-reviewing hover:underline"
                      aria-label="View originating turn and tool"
                      to={conversationLocation(
                        {
                          streamId: current.originStreamId ?? agentId,
                          blockId: current.originBlockId,
                          threadId: current.originThreadId ?? null,
                        },
                        archived
                      )}
                      onClick={() => {
                        setOpen(false);
                        setSelected(null);
                      }}
                    >
                      View turn
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      Unavailable
                    </span>
                  )}
                </div>
              </div>
              {(current.description || current.summary) && (
                <div className="space-y-2 border-l-2 border-status-reviewing/35 pl-3">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    Latest activity
                  </div>
                  {current.description && (
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {current.description}
                    </p>
                  )}
                  {current.summary &&
                    current.summary !== current.description && (
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                        {current.summary}
                      </p>
                    )}
                </div>
              )}
              <div className="overflow-hidden rounded-xl border border-border/60">
                <div className="flex items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2.5 text-xs font-medium">
                  <Terminal className="size-3.5 text-muted-foreground" />
                  Output
                  {current.taskType === "monitor" && (
                    <Badge className="ml-auto normal-case tracking-normal">
                      Sent to agent
                    </Badge>
                  )}
                </div>
                {detailQuery.isError ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-2 bg-status-waiting/5 p-3 text-xs"
                  >
                    <span className="flex items-center gap-2 text-status-waiting [[data-theme-mode=light]_&]:text-amber-800">
                      <CircleAlert className="size-4 shrink-0" />
                      Details unavailable.
                    </span>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 text-xs"
                      aria-label="Retry details"
                      onClick={() => void detailQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : detailQuery.isPending ? (
                  <div className="p-4 text-xs text-muted-foreground">
                    Loading output…
                  </div>
                ) : current.terminalOutput ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted/15 p-3 font-mono text-xs leading-relaxed">
                    {current.terminalOutput}
                  </pre>
                ) : (
                  <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
                    {current.taskType === "monitor" ? (
                      <>
                        <Radio className="size-4 shrink-0" />
                        Monitor output is sent to the agent.
                      </>
                    ) : (
                      <>
                        <Terminal className="size-4 shrink-0" />
                        No captured output.
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {snapshot?.capability !== "supported" &&
              !query.isPending &&
              !query.isError ? (
                <div className="flex flex-col items-center gap-3 py-9 text-center">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
                    <WifiOff className="size-5" />
                  </span>
                  <p className="max-w-64 text-sm font-medium">
                    Background visibility unavailable for this session.
                  </p>
                </div>
              ) : snapshot?.capability === "supported" && !items.length ? (
                <div className="flex flex-col items-center gap-3 py-9 text-center">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-status-reviewing/10 text-status-reviewing">
                    <Activity className="size-5" />
                  </span>
                  <p className="text-sm font-medium">
                    No reported background work.
                  </p>
                </div>
              ) : null}
              {active.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="mr-auto font-medium text-muted-foreground">
                      Open work{" "}
                      <span className="ml-1 tabular-nums text-foreground">
                        {active.length}
                      </span>
                    </span>
                    {running > 0 && (
                      <span className="flex items-center gap-1.5 text-status-working [[data-theme-mode=light]_&]:text-emerald-800">
                        <span className="size-1.5 rounded-full bg-status-working" />
                        {running} running
                      </span>
                    )}
                    {paused > 0 && (
                      <span className="flex items-center gap-1.5 text-status-waiting [[data-theme-mode=light]_&]:text-amber-800">
                        <Pause className="size-3" />
                        {paused} paused
                      </span>
                    )}
                    {uncertain > 0 && (
                      <span className="flex items-center gap-1 text-status-waiting [[data-theme-mode=light]_&]:text-amber-800">
                        <Clock3 className="size-3" />
                        {uncertain} stale / unknown
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">{active.map(renderRow)}</div>
                </>
              )}
              {finished.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1 text-xs font-medium text-muted-foreground">
                    <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                    Recent completed
                    <Badge className="ml-auto tabular-nums">
                      {finished.length}
                    </Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 pt-3">
                    {finished.slice(0, 30).map(renderRow)}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border/60 bg-muted/15 px-5 py-2.5 text-[11px] text-muted-foreground">
          <span>
            {snapshot?.truncated
              ? "Up to 200 retained reports"
              : "Reported work only"}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="About background visibility"
              >
                <Info className="size-3" />
                Visibility
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              className="z-[80] w-64 space-y-3 p-3 font-sans text-xs"
            >
              <div className="flex items-center gap-2">
                <Terminal className="size-4 shrink-0 text-engine-codex" />
                <div>
                  <strong className="font-medium">Codex</strong>
                  <p className="text-muted-foreground">
                    App-server-owned terminals
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Radio className="size-4 shrink-0 text-engine-claude" />
                <div>
                  <strong className="font-medium">Claude</strong>
                  <p className="text-muted-foreground">
                    Commands, monitors and autonomous work
                  </p>
                </div>
              </div>
              <p className="border-t border-border/60 pt-2 text-muted-foreground">
                Host support varies. Detached processes and future schedules are
                excluded.
              </p>
            </PopoverContent>
          </Popover>
        </div>
      </DialogContent>
    </Dialog>
  );
}
