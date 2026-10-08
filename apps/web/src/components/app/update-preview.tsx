import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useReleaseStream } from "@/hooks/use-release-stream";
import { OperationTakeover } from "./release-operation-takeover";
import { UPDATE_PHASES } from "./release-utils";

/** Loaded only by Vite's dev build, behind ?simulateUpdate. */
export default function UpdatePreview(): JSX.Element {
  const server = useRef<"old" | "offline" | "trial" | "ready">("old");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [running, setRunning] = useState(false);
  const transport = useMemo(
    () => ({
      fetchStatus: (async () => {
        if (server.current === "offline")
          throw new TypeError("Simulated server offline");
        if (server.current === "trial")
          return Response.json({ code: "PROBATION" }, { status: 503 });
        return Response.json({
          tag: server.current === "ready" ? "v9.9.9" : "v9.9.8",
          deployedAt: new Date().toISOString(),
        });
      }) as typeof fetch,
      createStream: () =>
        ({
          onmessage: null,
          onerror: null,
          close() {},
        }) as unknown as EventSource,
    }),
    []
  );
  const stream = useReleaseStream("update", transport);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const start = (longWait: boolean) => {
    setRunning(true);
    server.current = "old";
    stream.setJob({
      jobType: "update",
      versionType: null,
      phase: "fetching",
      startedAt: new Date().toISOString(),
      tag: "v9.9.9",
      log: ["==> confirming release v9.9.9"],
      runUrl: null,
      error: null,
      progress: {
        step: "download",
        label: "Downloading release",
        detail: "Simulated download",
      },
    });
    const later = (ms: number, action: () => void) =>
      timers.current.push(setTimeout(action, ms));
    later(2000, () =>
      stream.setJob((prev) =>
        prev?.jobType === "update"
          ? {
              ...prev,
              phase: "deploying",
              log: [
                ...prev.log,
                "==> release verified; preparing recovery transaction",
              ],
              progress: {
                step: "validating-artifact",
                label: "Preparing protected update",
                detail: "Verifying the artifact and backup before activation.",
              },
            }
          : prev
      )
    );
    later(5000, () => {
      server.current = "offline";
      stream.setJob((prev) =>
        prev?.jobType === "update"
          ? {
              ...prev,
              phase: "restarting",
              log: [
                ...prev.log,
                "Recovery helper will verify the backup and trial the update before commit.",
              ],
            }
          : prev
      );
    });
    later(12000, () => {
      server.current = "trial";
    });
    if (!longWait)
      later(22000, () => {
        server.current = "ready";
      });
  };
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <span className="text-xs text-muted-foreground">
          Simulated update — no installation changes. Completion reloads this
          page.
        </span>
        <Button disabled={running} onClick={() => start(false)}>
          Simulate update
        </Button>
        <Button
          variant="default"
          disabled={running}
          onClick={() => start(true)}
        >
          Simulate long wait
        </Button>
        <Button
          disabled={!running}
          variant="default"
          onClick={() => {
            timers.current.forEach(clearTimeout);
            timers.current = [];
            server.current = "ready";
            stream.setJob((prev) =>
              prev?.jobType === "update" &&
              prev.phase !== "done" &&
              prev.phase !== "failed"
                ? { ...prev, phase: "restarting" }
                : prev
            );
          }}
        >
          Finish simulation
        </Button>
      </div>
      {running && stream.job ? (
        <OperationTakeover
          job={stream.job}
          phasesOrder={[...UPDATE_PHASES]}
          isDone={stream.job.phase === "done"}
          isFailed={stream.job.phase === "failed"}
          isRestarting={stream.job.phase === "restarting"}
          postRestartPolling={stream.postRestartPolling}
          status={stream.status}
          onDismiss={() => stream.setJob(null)}
        />
      ) : (
        <div className="h-[720px] p-6 text-sm text-muted-foreground md:h-[560px]">
          {running
            ? "Simulation dismissed. Reloading the preview…"
            : "Start a simulation to watch download, preparation, downtime, startup health checks, completion, and automatic reload."}
        </div>
      )}
    </div>
  );
}
