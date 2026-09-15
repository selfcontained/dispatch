import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackgroundProcess } from "@dispatch/shared";
import { Check, CircleAlert, Square, SquareStack } from "lucide-react";

import { ComposerStrip } from "@/components/app/chat/composer-strip";
import {
  STRIP_ITEM_CLASS,
  STRIP_LIST_CLASS,
  STRIP_META_CLASS,
  STRIP_MORE_CLASS,
  STRIP_ROW_CLASS,
  STRIP_STATUS_CLASS,
} from "@/components/app/chat/composer-strip-styles";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const PREVIEW_COUNT = 4;

export function BackgroundProcesses({
  agentId,
}: {
  agentId: string;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
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
  const ordered = [...processes].sort(
    (a, b) => Number(b.status === "running") - Number(a.status === "running")
  );
  const shown = showAll ? ordered : ordered.slice(0, PREVIEW_COUNT);
  const hidden = Math.max(0, ordered.length - PREVIEW_COUNT);
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
    <>
      <ComposerStrip
        title="Background processes"
        icon={SquareStack}
        open={open}
        onOpenChange={setOpen}
        testId="background-processes"
        toggleRef={toggleRef}
        summary={
          <>
            {query.isError
              ? "Status unavailable"
              : active
                ? `${active} running`
                : `${processes.length} finished`}
            {!query.isError && failed > 0 ? ` · ${failed} need attention` : ""}
          </>
        }
        footer={
          query.isError ? (
            <p role="alert" className="mt-1 text-[10.5px] text-destructive">
              Could not refresh process status.{" "}
              <button
                type="button"
                className="underline pointer-coarse:min-h-11"
                onClick={() => void query.refetch()}
              >
                Retry
              </button>
            </p>
          ) : null
        }
      >
        <ul className={cn(STRIP_LIST_CLASS, "mt-1.5 pl-5")}>
          {shown.map((process) => (
            <li key={process.id}>
              <button
                type="button"
                title={`View output: ${process.title}`}
                data-testid="background-process-row"
                className={cn(
                  STRIP_ROW_CLASS,
                  "w-full rounded-sm text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50 pointer-coarse:min-h-11 pointer-coarse:items-center"
                )}
                onClick={(event) => {
                  rowRef.current = event.currentTarget;
                  stop.reset();
                  setSelected(process.id);
                }}
              >
                <span aria-hidden="true" className={STRIP_STATUS_CLASS}>
                  {process.status === "running" ? (
                    <ActivityBars size={9} />
                  ) : process.status === "completed" ? (
                    <Check size={11} className="text-status-done" />
                  ) : process.status === "failed" ||
                    process.status === "interrupted" ? (
                    <CircleAlert size={11} className="text-destructive" />
                  ) : (
                    <Square size={8} className="text-muted-foreground/60" />
                  )}
                </span>
                <span className="sr-only">View output: </span>
                <span
                  className={cn(
                    STRIP_ITEM_CLASS,
                    "truncate",
                    process.status === "running"
                      ? "font-medium text-foreground"
                      : "text-foreground/80"
                  )}
                >
                  {process.title}
                </span>
                <span
                  className={cn(STRIP_META_CLASS, "shrink-0 leading-[17px]")}
                >
                  {process.status} · {elapsed(process)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hidden > 0 ? (
          <button
            type="button"
            className={STRIP_MORE_CLASS}
            data-testid="background-processes-more"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `+${hidden} more`}
          </button>
        ) : null}
      </ComposerStrip>
      <Dialog
        open={!!detail}
        onOpenChange={(value) => {
          if (!value) setSelected(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
          data-testid="background-process-detail"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (rowRef.current?.isConnected
              ? rowRef.current
              : toggleRef.current
            )?.focus();
          }}
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
    </>
  );
}
