import { useCallback, useEffect, useRef, useState } from "react";
import { recordReleaseManagerPollFire } from "@/lib/energy-metrics";

export type ReleaseVersionType = "patch" | "minor" | "major";
export type ReleasePhase = "preflight" | "triggering" | "watching" | "fetching" | "deploying" | "restarting" | "done" | "failed";
export type ReleaseJobType = "create" | "update";

export type ReleaseChannel = "stable" | "latest";

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
};

export type ReleaseStatus = {
  tag: string | null;
  deployedAt: string | null;
};

export type ReleaseJob = {
  jobType: ReleaseJobType;
  versionType: ReleaseVersionType | null;
  phase: ReleasePhase;
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
};

type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string };

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
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

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
            setJob((prev) => prev ? { ...prev, phase: "done", tag: data.tag } : prev);
            setTimeout(() => window.location.reload(), 1500);
          }
        }
      } catch { /* server still down */ }
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
      setJob((prev) => {
        if (!prev) return prev;
        if (event.type === "log") return { ...prev, log: [...prev.log, event.line] };
        if (event.type === "log.rewind") {
          return { ...prev, log: prev.log.slice(0, -event.count) };
        }
        if (event.type === "log.replace") {
          const updated = [...prev.log];
          if (updated.length > 0) {
            updated[updated.length - 1] = event.line;
          } else {
            updated.push(event.line);
          }
          return { ...prev, log: updated };
        }
        if (event.type === "phase") return { ...prev, phase: event.phase, error: event.error ?? prev.error };
        if (event.type === "runUrl") return { ...prev, runUrl: event.url };
        if (event.type === "tag") return { ...prev, tag: event.tag };
        return prev;
      });
    };

    es.onerror = () => {
      setJob((prev) => {
        if (prev?.jobType === "update" && (prev.phase === "restarting" || prev.phase === "deploying")) {
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

  return { status, job, postRestartPolling, connectStream, fetchStatus, setJob };
}
