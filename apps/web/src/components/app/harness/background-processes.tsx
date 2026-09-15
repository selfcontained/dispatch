import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackgroundProcess } from "@dispatch/shared";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

export function BackgroundProcesses({
  agentId,
}: {
  agentId: string;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const client = useQueryClient();
  const key = ["background-processes", agentId];
  const query = useQuery<{ processes: BackgroundProcess[] }>({
    queryKey: key,
    queryFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId)}/harness/processes`),
    refetchInterval: 2000,
  });
  const stop = useMutation({
    mutationFn: (id: string) =>
      api(
        `/api/v1/agents/${encodeURIComponent(agentId)}/harness/processes/${encodeURIComponent(id)}/stop`,
        { method: "POST" }
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const processes = query.data?.processes ?? [];
  const detailQuery = useQuery<BackgroundProcess>({
    queryKey: [...key, selected],
    queryFn: () =>
      api(
        `/api/v1/agents/${encodeURIComponent(agentId)}/harness/processes/${encodeURIComponent(selected!)}`
      ),
    enabled: !!selected,
    refetchInterval: selected ? 2000 : false,
  });
  const active = processes.filter((p) => p.status === "running").length;
  const failed = processes.filter(
    (p) => p.status === "failed" || p.status === "interrupted"
  ).length;
  const detail = detailQuery.data ?? processes.find((p) => p.id === selected);
  const now = query.dataUpdatedAt || Date.now();
  if (!processes.length && !query.isError) return null;
  const elapsed = (process: BackgroundProcess) => {
    const seconds = Math.max(
      0,
      Math.floor(
        ((process.endedAt ? Date.parse(process.endedAt) : now) -
          Date.parse(process.startedAt)) /
          1000
      )
    );
    return seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  return (
    <section
      className="mb-2 min-w-0 rounded-md border border-border/60 text-xs"
      data-testid="background-processes"
    >
      <div>
        <Button
          variant="ghost"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left"
          data-testid="background-processes-toggle"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Terminal size={14} />
          <span>Background processes</span>
          <span className="ml-auto text-muted-foreground" aria-live="polite">
            {query.isError
              ? "Status unavailable"
              : active
                ? `${active} running`
                : `${processes.length} finished`}
            {!query.isError && failed > 0 ? ` · ${failed} need attention` : ""}
          </span>
        </Button>
        <div id={listId} hidden={!open}>
          <div className="max-h-48 overflow-y-auto border-t border-border/60">
            {processes.map((process) => (
              <button
                key={process.id}
                type="button"
                className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  stop.reset();
                  setSelected(process.id);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{process.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {process.status} · {elapsed(process)}
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="px-3 pb-2 text-destructive">
          Could not refresh process status.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      ) : null}
      <Dialog
        open={!!detail}
        onOpenChange={(value) => {
          if (!value) setSelected(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
          data-testid="background-process-detail"
        >
          <DialogHeader>
            <DialogTitle className="break-words">{detail?.title}</DialogTitle>
            <DialogDescription>
              {detail?.status} · {detail ? elapsed(detail) : ""}
              {detail?.exitCode !== null && detail?.exitCode !== undefined
                ? ` · exit ${detail.exitCode}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <code className="break-all text-xs">{detail?.command}</code>
          <p className="break-all text-xs text-muted-foreground">
            Working directory: {detail?.cwd}
          </p>
          {detail?.truncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the most recent output (older output was truncated).
            </p>
          ) : null}
          <pre
            className="max-h-[45dvh] min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs"
            tabIndex={0}
            aria-label="Process output"
          >
            {detailQuery.isError
              ? "Could not refresh output. Close and reopen to retry."
              : detail?.output || "No output yet."}
          </pre>
          {stop.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {stop.error instanceof Error
                ? stop.error.message
                : "Could not stop the process."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => setSelected(null)}
            >
              Close
            </Button>
            {detail?.status === "running" ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={stop.isPending}
                onClick={() => stop.mutate(detail.id)}
              >
                {stop.isPending ? "Stopping…" : "Stop process"}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
