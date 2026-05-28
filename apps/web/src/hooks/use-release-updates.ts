import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  ReleaseChannel,
  ReleaseInfo,
  UseReleaseStreamResult,
} from "@/hooks/use-release-stream";
import { api } from "@/lib/api";
import { agentRoute } from "@/lib/agent-routes";
import {
  useCachedReleaseInfo,
  type ReleaseInfoSnapshot,
} from "@/hooks/use-cached-release-info";
import { clearCachesAndReload, reloadApp } from "@/lib/pwa-update";
import {
  cleanError,
  type AppVersionInfo,
} from "@/components/app/release-manager-utils";

export function useReleaseUpdates(stream: UseReleaseStreamResult) {
  const navigate = useNavigate();
  const {
    status,
    job,
    infoProgress,
    postRestartPolling,
    streamClientId,
    connectStream,
    setJob,
  } = stream;

  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [channel, setChannel] = useState<ReleaseChannel>("stable");
  const [channelSaving, setChannelSaving] = useState(false);
  const [autoUpdateMode, setAutoUpdateMode] = useState<"off" | "check">(
    "check"
  );
  const [autoUpdateSaving, setAutoUpdateSaving] = useState(false);
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [assistedUpdateLaunching, setAssistedUpdateLaunching] = useState(false);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [lastCheckMessage, setLastCheckMessage] = useState<string | null>(null);
  const reloadingRef = useRef(false);

  const cachedInfoQuery = useCachedReleaseInfo();
  const cachedSnapshot = cachedInfoQuery.data?.snapshot ?? null;

  const cachedSnapshotForChannel =
    cachedSnapshot && cachedSnapshot.channel === channel
      ? cachedSnapshot
      : null;
  const displayInfo: ReleaseInfo | ReleaseInfoSnapshot | null =
    info ?? cachedSnapshotForChannel;

  useEffect(() => {
    let cancelled = false;
    void api<AppVersionInfo>("/api/v1/app/version")
      .then((data) => {
        if (!cancelled) setVersionInfo(data);
      })
      .catch(() => {});
    void api<{ channel: ReleaseChannel }>("/api/v1/release/channel")
      .then((data) => {
        if (!cancelled) setChannel(data.channel);
      })
      .catch(() => {});
    void api<{ mode: "off" | "check" }>("/api/v1/release/auto-update-mode")
      .then((data) => {
        if (!cancelled) setAutoUpdateMode(data.mode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoUpdateModeChange = useCallback(
    async (next: "off" | "check") => {
      setAutoUpdateMode(next);
      setAutoUpdateSaving(true);
      try {
        await api("/api/v1/release/auto-update-mode", {
          method: "POST",
          body: JSON.stringify({ mode: next }),
        });
      } catch {
        setAutoUpdateMode((prev) => (prev === "off" ? "check" : "off"));
      } finally {
        setAutoUpdateSaving(false);
      }
    },
    []
  );

  const handleChannelChange = useCallback(async (value: ReleaseChannel) => {
    setChannel(value);
    setChannelSaving(true);
    try {
      await api("/api/v1/release/channel", {
        method: "POST",
        body: JSON.stringify({ channel: value }),
      });
      setInfo(null);
    } catch {
      setChannel((prev) => (prev === "stable" ? "latest" : "stable"));
    } finally {
      setChannelSaving(false);
    }
  }, []);

  const handleCheckForUpdates = async () => {
    setInfoLoading(true);
    setInfoError(null);
    setInfo(null);
    setLastCheckMessage(null);
    try {
      const res = await fetch("/api/v1/release/info", {
        headers: {
          "X-Dispatch-Release-Client-Id": streamClientId,
        },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setInfoError(cleanError(err.error ?? "Failed to check for updates"));
        return;
      }
      const nextInfo = (await res.json()) as ReleaseInfo;
      setInfo(nextInfo);
      if (!nextInfo.updateAvailable) {
        setLastCheckMessage("Up to date");
      }
    } catch (err) {
      setInfoError(
        err instanceof Error
          ? cleanError(err.message)
          : "Failed to check for updates"
      );
    } finally {
      setInfoLoading(false);
    }
  };

  useEffect(() => {
    if (lastCheckMessage === null) return;
    const timeout = window.setTimeout(() => {
      setLastCheckMessage(null);
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [lastCheckMessage]);

  const handleUpdate = async (tag: string, options?: { force?: boolean }) => {
    setUpdateError(null);
    const res = await fetch("/api/v1/release/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, force: options?.force === true }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setUpdateError(cleanError(err.error ?? "Failed to start update"));
      return;
    }
    setJob({
      jobType: "update",
      versionType: null,
      phase: "fetching",
      startedAt: new Date().toISOString(),
      log: [],
      runUrl: null,
      tag,
      error: null,
      progress: {
        step: "starting-update",
        label: "Starting update",
        detail: "Preparing the update job and connecting to progress events.",
      },
    });
    connectStream();
  };

  const handleAssistedUpdate = useCallback(
    async (tag: string) => {
      setUpdateError(null);
      setAssistedUpdateLaunching(true);
      try {
        const payload = await api<{ agent: { id: string } }>(
          "/api/v1/release/assisted/launch",
          {
            method: "POST",
            body: JSON.stringify({ tag }),
          }
        );
        navigate(agentRoute(payload.agent.id));
      } catch (err) {
        setUpdateError(
          err instanceof Error
            ? cleanError(err.message)
            : "Failed to start assisted update"
        );
      } finally {
        setAssistedUpdateLaunching(false);
      }
    },
    [navigate]
  );

  const handleReload = useCallback(() => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    void reloadApp();
  }, []);

  const handleClearCacheAndReload = useCallback(() => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    void clearCachesAndReload();
  }, []);

  const handleDismiss = useCallback(() => {
    setJob(null);
    setInfo(null);
    setUpdateError(null);
  }, [setJob]);

  const handleAssistedDismiss = useCallback(() => {
    void fetch("/api/v1/release/assisted/state", {
      method: "DELETE",
    }).catch(() => {});
    setJob(null);
    setInfo(null);
    setUpdateError(null);
  }, [setJob]);

  const updateJob = job?.jobType === "update" ? job : null;
  const assistedJob = job?.jobType === "update-assisted" ? job : null;
  const isDone =
    updateJob?.phase === "done" ||
    (!postRestartPolling &&
      updateJob?.phase === "restarting" &&
      status?.tag === updateJob?.tag);
  const isFailed = updateJob?.phase === "failed";
  const isRestarting =
    updateJob?.phase === "restarting" ||
    (updateJob !== null && postRestartPolling);
  const showTakeover = updateJob !== null && !isDone;

  return {
    status,
    infoProgress,
    postRestartPolling,

    versionInfo,
    notesExpanded,
    setNotesExpanded,
    channel,
    channelSaving,
    autoUpdateMode,
    autoUpdateSaving,
    infoLoading,
    infoError,
    updateError,
    assistedUpdateLaunching,
    forceConfirmOpen,
    setForceConfirmOpen,
    lastCheckMessage,

    displayInfo,

    updateJob,
    assistedJob,
    isDone,
    isFailed,
    isRestarting,
    showTakeover,

    handleAutoUpdateModeChange,
    handleChannelChange,
    handleCheckForUpdates,
    handleUpdate,
    handleAssistedUpdate,
    handleReload,
    handleClearCacheAndReload,
    handleDismiss,
    handleAssistedDismiss,
  };
}
