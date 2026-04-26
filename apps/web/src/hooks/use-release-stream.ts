import { useCallback, useEffect, useRef, useState } from "react";
import { recordReleaseManagerPollFire } from "@/lib/energy-metrics";
import { forcePWAUpdate } from "@/lib/pwa-update";

export type ReleaseVersionType = "patch" | "minor" | "major";

export type CreatePhase =
  | "preflight"
  | "triggering"
  | "watching"
  | "done"
  | "failed";
export type UpdatePhase =
  | "fetching"
  | "deploying"
  | "restarting"
  | "done"
  | "failed";
export type AssistedReleasePhase =
  | "inspect"
  | "prepare"
  | "apply"
  | "restarting"
  | "validate"
  | "done"
  | "rollback"
  | "blocked"
  | "failed";

// Broad union for stream `phase` events whose source variant is opaque
// to the receiver. Per-variant phase narrowing happens through
// `ReleaseJob` below.
export type ReleasePhase = CreatePhase | UpdatePhase | AssistedReleasePhase;

export type ReleaseJobType = "create" | "update" | "update-assisted";

export type ReleaseChannel = "stable" | "latest";

export type AssistedUpdateMode = "normal" | "recommended" | "required";

export type AssistedRequiredCheck =
  | "expected_runtime_artifact"
  | "service_entrypoint"
  | "service_restarted"
  | "health_endpoint"
  | "version_converged";

export type AssistedUpdateMetadata = {
  mode: AssistedUpdateMode;
  title: string;
  summary: string;
  instructions?: string;
  requiredChecks: Array<
    | AssistedRequiredCheck
    | { name: AssistedRequiredCheck; description?: string }
  >;
  rollbackGuidance?: string;
  appliesFrom?: string;
};

export type AssistedCheckResult = {
  name: AssistedRequiredCheck;
  ok: boolean;
  message: string;
};

export type AssistedUpdateState = {
  tag: string;
  fromTag: string | null;
  metadata: AssistedUpdateMetadata;
  requiredChecks: AssistedRequiredCheck[];
  phase: ReleasePhase;
  agentId: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  checks: AssistedCheckResult[];
  notes: Partial<Record<ReleasePhase, string>>;
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
  assisted?: AssistedUpdateMetadata | null;
  assistedRequired?: boolean;
};

export type ReleaseStatus = {
  tag: string | null;
  deployedAt: string | null;
};

type CommonReleaseJobFields = {
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
};

export type ReleaseJob =
  | (CommonReleaseJobFields & {
      jobType: "create";
      versionType: ReleaseVersionType;
      phase: CreatePhase;
    })
  | (CommonReleaseJobFields & {
      jobType: "update";
      versionType: null;
      phase: UpdatePhase;
    })
  | (CommonReleaseJobFields & {
      jobType: "update-assisted";
      versionType: null;
      phase: AssistedReleasePhase;
      /**
       * Required on the assisted variant — the gate flow always
       * populates it before the job is published, and the takeover
       * unconditionally renders against it.
       */
      assisted: AssistedUpdateState;
    });

type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string }
  | { type: "assisted"; state: AssistedUpdateState };

/**
 * Apply a non-snapshot stream event to the previous job state. The
 * union narrowing keeps us honest: the `phase` event carries a broad
 * `ReleasePhase`, and we have to cast it to whichever variant `prev`
 * actually is — that cast is the one place "trust the wire" lives.
 */
function applyStreamEvent(
  prev: ReleaseJob | null,
  event: Exclude<ReleaseStreamEvent, { type: "snapshot" }>
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
  postRestartPolling: boolean;
  connectStream: () => void;
  fetchStatus: () => Promise<void>;
  setJob: React.Dispatch<React.SetStateAction<ReleaseJob | null>>;
};

export function useReleaseStream(): UseReleaseStreamResult {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [job, setJob] = useState<ReleaseJob | null>(null);
  const [postRestartPolling, setPostRestartPolling] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/release/status");
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
            setTimeout(() => void forcePWAUpdate(true), 1500);
          }
        }
      } catch {
        /* server still down */
      }
    }, 2000);
  }, []);

  const connectStream = useCallback(() => {
    eventSourceRef.current?.close();
    const es = new EventSource("/api/v1/release/stream");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as ReleaseStreamEvent;
      if (event.type === "snapshot") {
        setJob(event.job);
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
  }, [startHealthPoll]);

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
    postRestartPolling,
    connectStream,
    fetchStatus,
    setJob,
  };
}
