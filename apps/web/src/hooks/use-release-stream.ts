import { createClientId } from "@/lib/client-id";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordReleaseManagerPollFire } from "@/lib/energy-metrics";
import { reloadApp } from "@/lib/pwa-update";
import { noteServerVersion } from "@/lib/version";

// Wire types are defined once on the server and imported type-only — esbuild
// erases these imports, so nothing from the server reaches the web bundle.
import type {
  CreatePhase,
  ReleaseJob,
  ReleasePhase,
  ReleaseProgress,
  ReleaseStreamEvent,
  ReleaseVersionType,
  UpdatePhase,
} from "../../../server/src/server/release-wire";
import type { ReleaseChannel } from "../../../server/src/release-info";

export type {
  CreatePhase,
  ReleaseChannel,
  ReleaseJob,
  ReleasePhase,
  ReleaseProgress,
  ReleaseVersionType,
  UpdatePhase,
};

export type ReleaseInfo = {
  currentTag: string | null;
  channel: ReleaseChannel;
  isAdmin: boolean;
  latestTag: string | null;
  updateAvailable: boolean;
  latestRelease: { tag: string; publishedAt: string; url: string } | null;
  unreleasedCount: number;
  commits: Array<{ sha: string; subject: string }>;
  refMissing?: boolean;
  /**
   * Set when refreshing origin/main in the authoring checkout failed —
   * unreleased-commit info is unknown, not zero.
   */
  unreleasedFetchError?: string | null;
};

export type ReleaseStatus = {
  tag: string | null;
  deployedAt: string | null;
};

/**
 * Apply a non-snapshot stream event to the previous job state. The
 * union narrowing keeps us honest: the `phase` event carries a broad
 * `ReleasePhase`, and we have to cast it to whichever variant `prev`
 * actually is — that cast is the one place "trust the wire" lives.
 */
export function applyStreamEvent(
  prev: ReleaseJob | null,
  event: Exclude<
    ReleaseStreamEvent,
    { type: "snapshot" } | { type: "info-progress" }
  >
): ReleaseJob | null {
  if (!prev) return prev;
  switch (event.type) {
    case "log":
      return { ...prev, log: [...prev.log, event.line] };
    case "log.rewind":
      return { ...prev, log: prev.log.slice(0, -event.count) };
    case "log.replace": {
      const updated = [...prev.log];
      if (updated.length > 0) {
        updated[updated.length - 1] = event.line;
      } else {
        updated.push(event.line);
      }
      return { ...prev, log: updated };
    }
    case "phase": {
      // The wire phase is a broad union; the variant's `phase` is
      // narrower. The server is the authority on which phase belongs
      // to which jobType, so we cast at the boundary per variant.
      const error = event.error ?? prev.error;
      if (prev.jobType === "create") {
        return { ...prev, phase: event.phase as CreatePhase, error };
      }
      return { ...prev, phase: event.phase as UpdatePhase, error };
    }
    case "progress":
      return { ...prev, progress: event.progress };
    case "runUrl":
      return { ...prev, runUrl: event.url };
    case "tag":
      return { ...prev, tag: event.tag };
  }
}

export type UseReleaseStreamResult = {
  status: ReleaseStatus | null;
  job: ReleaseJob | null;
  infoProgress: ReleaseProgress | null;
  postRestartPolling: boolean;
  streamClientId: string;
  connectStream: () => void;
  fetchStatus: () => Promise<void>;
  setJob: React.Dispatch<React.SetStateAction<ReleaseJob | null>>;
};

/**
 * "create" backs the admin Releases page (cutting a new release); "update"
 * backs the all-users Updates page (applying one). Each kind gets its own
 * SSE connection to a dedicated endpoint so the two features never share
 * job state — an in-flight release must never block, or be confused with,
 * an in-flight update, or vice versa.
 */
export type ReleaseStreamKind = "create" | "update";

export function useReleaseStream(
  kind: ReleaseStreamKind,
  transport?: {
    fetchStatus: typeof fetch;
    createStream: (url: string) => EventSource;
  }
): UseReleaseStreamResult {
  const statusFetch = transport?.fetchStatus ?? fetch;
  const createStream = transport?.createStream;
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [job, setJob] = useState<ReleaseJob | null>(null);
  const [infoProgress, setInfoProgress] = useState<ReleaseProgress | null>(
    null
  );
  const [postRestartPolling, setPostRestartPolling] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientIdRef = useRef<string>(createClientId());

  const fetchStatus = useCallback(async () => {
    try {
      const res = await statusFetch("/api/v1/release/status");
      noteServerVersion(res.headers.get("X-Dispatch-Version"));
      if (res.ok) setStatus((await res.json()) as ReleaseStatus);
    } catch {
      /* ignore */
    }
  }, [statusFetch]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Start on the restart phase itself: a proxy or browser can keep the SSE
  // connection open without ever delivering an error during a service restart.
  const restartingTag =
    job?.jobType === "update" && job.phase === "restarting" ? job.tag : null;
  useEffect(() => {
    if (!restartingTag) return;
    setPostRestartPolling(true);
    let cancelled = false;
    let checking = false;
    const started = Date.now();
    let lastStep = "";
    let lastMessageAt = started;
    const report = (step: string, label: string, detail: string) => {
      if (cancelled) return;
      const changed = step !== lastStep;
      if (!changed && Date.now() - lastMessageAt < 15_000) return;
      lastStep = step;
      lastMessageAt = Date.now();
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setJob((prev) =>
        prev?.jobType === "update" && prev.phase === "restarting"
          ? {
              ...prev,
              progress: { step, label, detail },
              log: [
                ...prev.log,
                changed
                  ? `==> ${label}`
                  : `==> ${label} (${elapsed}s elapsed; checking automatically)`,
              ],
            }
          : prev
      );
    };
    let controller: AbortController | undefined;
    const check = async () => {
      if (cancelled || checking || document.hidden) return;
      checking = true;
      recordReleaseManagerPollFire();
      controller = new AbortController();
      const requestController = controller;
      const timeout = setTimeout(() => requestController.abort(), 10_000);
      try {
        const res = await statusFetch("/api/v1/release/status", {
          cache: "no-store",
          signal: requestController.signal,
        });
        if (!res.ok) {
          const error = (await res.json().catch(() => null)) as {
            code?: string;
          } | null;
          if (error?.code === "PROBATION") {
            report(
              "restart-health-check",
              "Checking startup health",
              "Dispatch is back in recovery mode. The helper checks stability for at least a minute before committing and restarting normally."
            );
          } else {
            report(
              "restart-unavailable",
              "Waiting for Dispatch to respond",
              "Automatic checks continue while the update finishes. This page will reload when the updated server is ready."
            );
          }
          return;
        }
        const data = (await res.json()) as ReleaseStatus;
        if (cancelled) return;
        if (data.tag !== restartingTag) {
          report(
            "restart-awaiting-version",
            "Server responding; waiting for updated version",
            "Dispatch is responding, but the new release has not been confirmed yet. Automatic checks continue."
          );
          return;
        }
        cancelled = true;
        clearInterval(healthPollRef.current!);
        healthPollRef.current = null;
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        noteServerVersion(res.headers.get("X-Dispatch-Version"));
        setPostRestartPolling(false);
        setStatus(data);
        setJob((prev) =>
          prev ? { ...prev, phase: "done", tag: data.tag } : prev
        );
        reloadTimerRef.current = setTimeout(() => void reloadApp(), 1500);
      } catch {
        report(
          "restart-offline",
          "Server offline while the update runs",
          "Backup and installation run independently while Dispatch is stopped. Automatic checks continue; this page will reload when ready."
        );
      } finally {
        clearTimeout(timeout);
        checking = false;
      }
    };
    healthPollRef.current = setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      controller?.abort();
      if (healthPollRef.current) clearInterval(healthPollRef.current);
      setPostRestartPolling(false);
    };
  }, [restartingTag, statusFetch]);

  const connectStream = useCallback(() => {
    eventSourceRef.current?.close();
    const es = (createStream ?? ((url: string) => new EventSource(url)))(
      `/api/v1/release/${kind}/stream?clientId=${encodeURIComponent(clientIdRef.current)}`
    );
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as ReleaseStreamEvent;
      if (event.type === "snapshot") {
        setJob(event.job);
        return;
      }
      if (event.type === "info-progress") {
        setInfoProgress(event.progress);
        return;
      }
      setJob((prev) => applyStreamEvent(prev, event));
    };

    es.onerror = () => {
      setJob((prev) => {
        if (
          prev?.jobType === "update" &&
          (prev.phase === "restarting" || prev.phase === "deploying")
        ) {
          return { ...prev, phase: "restarting" };
        }
        return prev;
      });
      es.close();
      eventSourceRef.current = null;
    };
  }, [kind, createStream]);

  useEffect(() => {
    connectStream();
    return () => {
      eventSourceRef.current?.close();
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      if (healthPollRef.current) clearInterval(healthPollRef.current);
    };
  }, [connectStream]);

  return {
    status,
    job,
    infoProgress,
    postRestartPolling,
    streamClientId: clientIdRef.current,
    connectStream,
    fetchStatus,
    setJob,
  };
}
