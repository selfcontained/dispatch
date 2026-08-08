import { useCallback, useEffect, useRef, useState } from "react";
import { recordReleaseManagerPollFire } from "@/lib/energy-metrics";
import { reloadApp } from "@/lib/pwa-update";
import { noteServerVersion } from "@/lib/version";

// Wire types are defined once on the server and imported type-only — esbuild
// erases these imports, so nothing from the server reaches the web bundle.
import type {
  AssistedReleasePhase,
  CreatePhase,
  ReleaseJob,
  ReleasePhase,
  ReleaseProgress,
  ReleaseStreamEvent,
  ReleaseVersionType,
  UpdatePhase,
} from "../../../server/src/server/release-wire";
import type { AssistedUpdateState } from "../../../server/src/assisted-update-store";
import type {
  AssistedUpdateMetadata,
  AssistedUpdateMode,
  RequiredCheckName,
} from "../../../server/src/release-metadata";
import type { CheckResult } from "../../../server/src/release-checks";
import type { UpdateMigrationManifest } from "../../../server/src/update-migrations";
import type { PendingMigrationSummary } from "../../../server/src/update-migrations-evaluator";
import type { ReleaseChannel } from "../../../server/src/release-info";

export type {
  AssistedReleasePhase,
  AssistedUpdateMetadata,
  AssistedUpdateMode,
  AssistedUpdateState,
  CreatePhase,
  ReleaseChannel,
  ReleaseJob,
  ReleasePhase,
  ReleaseProgress,
  ReleaseVersionType,
  UpdateMigrationManifest,
  UpdatePhase,
};

// These server types carry different names; keep the names web code uses.
export type AssistedRequiredCheck = RequiredCheckName;
export type AssistedCheckResult = CheckResult;
export type PendingMigration = PendingMigrationSummary;

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
  assisted?: AssistedUpdateMetadata | null;
  assistedRequired?: boolean;
  /**
   * Ordered, install-specific list of migrations the target tag declares
   * that the local install hasn't applied yet. When non-empty, one-click
   * update is gated and the operator must use the assisted-update flow.
   */
  pendingMigrations?: PendingMigration[];
  /** Joined per-file load errors when the migration evaluator hit issues. */
  migrationsError?: string | null;
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
      if (prev.jobType === "update") {
        return { ...prev, phase: event.phase as UpdatePhase, error };
      }
      return { ...prev, phase: event.phase as AssistedReleasePhase, error };
    }
    case "progress":
      return { ...prev, progress: event.progress };
    case "runUrl":
      return { ...prev, runUrl: event.url };
    case "tag":
      return { ...prev, tag: event.tag };
    case "assisted":
      // Only the assisted variant has a place to put this; ignore for
      // any other in-flight job. (The server only emits this for
      // `update-assisted` jobs in practice.)
      if (prev.jobType !== "update-assisted") return prev;
      return { ...prev, assisted: event.state };
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
  kind: ReleaseStreamKind
): UseReleaseStreamResult {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [job, setJob] = useState<ReleaseJob | null>(null);
  const [infoProgress, setInfoProgress] = useState<ReleaseProgress | null>(
    null
  );
  const [postRestartPolling, setPostRestartPolling] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clientIdRef = useRef<string>(
    globalThis.crypto?.randomUUID?.() ?? `release-${Date.now()}`
  );

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/release/status");
      noteServerVersion(res.headers.get("X-Dispatch-Version"));
      if (res.ok) setStatus((await res.json()) as ReleaseStatus);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const startHealthPoll = useCallback((expectedTag: string | null) => {
    setPostRestartPolling(true);
    if (healthPollRef.current) clearInterval(healthPollRef.current);

    healthPollRef.current = setInterval(async () => {
      if (document.hidden) return;
      recordReleaseManagerPollFire();
      try {
        const res = await fetch("/api/v1/release/status");
        noteServerVersion(res.headers.get("X-Dispatch-Version"));
        if (res.ok) {
          const data = (await res.json()) as ReleaseStatus;
          if (data.tag && data.tag === expectedTag) {
            clearInterval(healthPollRef.current!);
            healthPollRef.current = null;
            setPostRestartPolling(false);
            setStatus(data);
            setJob((prev) =>
              prev ? { ...prev, phase: "done", tag: data.tag } : prev
            );
            setTimeout(() => void reloadApp(), 1500);
          }
        }
      } catch {
        /* server still down */
      }
    }, 2000);
  }, []);

  const connectStream = useCallback(() => {
    eventSourceRef.current?.close();
    const es = new EventSource(
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
          startHealthPoll(prev.tag);
          return { ...prev, phase: "restarting" };
        }
        return prev;
      });
      es.close();
      eventSourceRef.current = null;
    };
  }, [kind, startHealthPoll]);

  useEffect(() => {
    connectStream();
    return () => {
      eventSourceRef.current?.close();
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
