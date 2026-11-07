import { conversationLocation } from "./chat/conversation-location-link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { BackgroundItem, BackgroundSnapshot } from "@dispatch/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";

const terminal = (item: BackgroundItem) =>
  ["completed", "failed", "stopped"].includes(item.state ?? "");
const stateLabel = (item: BackgroundItem) =>
  item.stale && !terminal(item)
    ? `Last reported ${item.state ?? "unknown"} · stale`
    : (item.state ?? "Unknown");

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
  const renderRow = (item: BackgroundItem) => (
    <button
      key={`${item.generation}:${item.id}`}
      className="w-full rounded-md border p-3 text-left hover:bg-muted/50"
      onClick={() => setSelected(`${item.generation}:${item.id}`)}
    >
      <span className="block break-words font-medium">
        {item.name || "Reported background work"}
      </span>
      <span className="block text-sm text-muted-foreground">
        {item.taskType ?? "Type unavailable"} · {stateLabel(item)}
      </span>
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
          <span>Background work</span>
          {knownCount > 0 && <span>{knownCount}</span>}
          {stale && (
            <span
              className="text-amber-500"
              title="Some observations are stale"
            >
              ●
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:w-full max-sm:max-h-[90dvh] max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Background work</DialogTitle>
            <DialogClose asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close background work"
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription>
            Explicitly reported work. Foreground idle does not mean background
            work has ended.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {query.isPending && <p>Loading reported work…</p>}
          {query.isError && (
            <p role="alert">
              Background visibility unavailable. Previously reported state may
              be stale.
            </p>
          )}
          {snapshot?.capability !== "supported" &&
            !query.isPending &&
            !query.isError && (
              <p>Background visibility unavailable for this session.</p>
            )}
          {snapshot?.stale && (
            <p className="text-sm text-muted-foreground">
              Observation ended. Retaining last reported state; process liveness
              is unknown.
            </p>
          )}
          {snapshot?.identityOverflow && (
            <p role="alert">
              Identity retention capacity reached. Additional work cannot be
              safely identified for this connection.
            </p>
          )}
          {snapshot?.truncated && (
            <p className="text-sm text-muted-foreground">
              Showing up to 200 retained reports. Older observations were
              omitted.
            </p>
          )}
          {current ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft className="mr-1 size-4" />
                Back to reported work
              </Button>
              <h3 className="break-words font-medium">
                {current.name || "Reported background work"}
              </h3>
              <p>
                {current.taskType ?? "Type unavailable"} · {stateLabel(current)}
              </p>
              <p className="text-sm text-muted-foreground">
                Reported by {current.provider} ·{" "}
                {new Date(current.lastObservation).toLocaleString()}
              </p>
              {current.taskType === "monitor" && current.canStop === false && (
                <p className="text-sm text-muted-foreground">
                  This monitor reports no stop support.
                </p>
              )}
              {current.description && (
                <p className="whitespace-pre-wrap break-words">
                  {current.description}
                </p>
              )}
              {current.summary && (
                <p className="whitespace-pre-wrap break-words">
                  {current.summary}
                </p>
              )}
              {current.toolCallId && (
                <p className="break-all text-xs text-muted-foreground">
                  Originating tool: {current.toolCallId}
                </p>
              )}
              {current.originBlockId ? (
                <Link
                  className="text-sm underline"
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
                  View originating turn and tool
                </Link>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Origin unavailable
                </p>
              )}
              {detailQuery.isError && (
                <p role="alert" className="text-sm">
                  Details could not be refreshed. State uses the latest
                  available report; output is unavailable.{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void detailQuery.refetch()}
                  >
                    Retry details
                  </Button>
                </p>
              )}
              {detailQuery.isPending ? (
                <p>Loading details…</p>
              ) : detailQuery.isError ? null : current.terminalOutput ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                  {current.terminalOutput}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {current.taskType === "monitor"
                    ? "Monitor output is delivered to the agent. Output is not available here."
                    : "Output is not available here."}
                </p>
              )}
            </>
          ) : (
            <>
              {snapshot?.capability === "supported" && !items.length && (
                <p>No reported background work.</p>
              )}
              {active.map(renderRow)}
              {items.some(terminal) && (
                <details>
                  <summary className="cursor-pointer py-2 text-sm">
                    Recent completed work
                  </summary>
                  <div className="space-y-2">
                    {items.filter(terminal).slice(0, 30).map(renderRow)}
                  </div>
                </details>
              )}
              <p className="text-xs text-muted-foreground">
                Visibility depends on the host CLI. Codex reports
                app-server-owned terminals; Claude can also report monitors.
                Detached processes and future schedules are not inventoried.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
