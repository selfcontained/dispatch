import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ReleaseChannel,
  ReleaseInfo,
  UseReleaseStreamResult,
} from "@/hooks/use-release-stream";
import { api } from "@/lib/api";
import {
  useCachedReleaseInfo,
  type ReleaseInfoSnapshot,
} from "@/hooks/use-cached-release-info";
import { clearCachesAndReload, reloadApp } from "@/lib/pwa-update";
import {
  cleanError,
  type AppVersionInfo,
} from "@/components/app/release-utils";
import { useAutoSave } from "@/hooks/use-auto-save";
import { errorMessage } from "@/lib/errors";

const LOAD_PREFERENCES_FAILED = "Couldn’t load update preferences.";

/**
 * Takes the update stream as a param rather than opening its own — the
 * stream must survive switching settings sections mid-update (the health
 * poll after a restart lives only in this client-side state, since the
 * server is briefly down and can't hand it back via a fresh snapshot), so
 * the caller owns it at a level that outlives this component. See
 * settings-pane.tsx.
 */
export function useReleaseUpdates(stream: UseReleaseStreamResult) {
  const {
    status,
    job,
    infoProgress,
    postRestartPolling,
    streamClientId,
    connectStream,
    setJob,
  } = stream;

  const versionQuery = useQuery({
    queryKey: ["release", "app-version"],
    queryFn: () => api<AppVersionInfo>("/api/v1/app/version"),
    retry: false,
  });
  const versionInfo = versionQuery.data ?? null;
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [channel, setChannel] = useState<ReleaseChannel>("stable");
  const [autoUpdateMode, setAutoUpdateMode] = useState<"off" | "check">(
    "check"
  );
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [preferencesError, setPreferencesError] = useState<{
    title: string;
    error: unknown;
  }>();
  const [lastCheckMessage, setLastCheckMessage] = useState<string | null>(null);
  const reloadingRef = useRef(false);

  const channelSave = useAutoSave<ReleaseChannel, "channel">(
    async (_, value) => {
      await api("/api/v1/release/channel", {
        method: "POST",
        body: JSON.stringify({ channel: value }),
      });
      setChannel(value);
      setInfo(null);
    }
  );
  const modeSave = useAutoSave<"off" | "check", "mode">(async (_, mode) => {
    await api("/api/v1/release/auto-update-mode", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
    setAutoUpdateMode(mode);
  });
  const shownChannel = channelSave.value("channel", channel);
  const { save: saveChannel } = channelSave;
  const { save: saveMode } = modeSave;
  const cachedInfoQuery = useCachedReleaseInfo();
  const cachedSnapshot = cachedInfoQuery.data?.snapshot ?? null;

  const cachedSnapshotForChannel =
    cachedSnapshot && cachedSnapshot.channel === shownChannel
      ? cachedSnapshot
      : null;
  const displayInfo: ReleaseInfo | ReleaseInfoSnapshot | null =
    info ?? cachedSnapshotForChannel;

  useEffect(() => {
    let cancelled = false;
    void api<{ channel: ReleaseChannel }>("/api/v1/release/channel")
      .then((data) => {
        if (!cancelled) setChannel(data.channel);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setPreferencesError({ title: LOAD_PREFERENCES_FAILED, error });
      });
    void api<{ mode: "off" | "check" }>("/api/v1/release/auto-update-mode")
      .then((data) => {
        if (!cancelled) setAutoUpdateMode(data.mode);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setPreferencesError({ title: LOAD_PREFERENCES_FAILED, error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoUpdateModeChange = useCallback(
    (next: "off" | "check") => saveMode("mode", next),
    [saveMode]
  );
  const handleChannelChange = useCallback(
    (value: ReleaseChannel) => saveChannel("channel", value),
    [saveChannel]
  );

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
        setInfoError(cleanError(err.error ?? "Couldn’t check for updates."));
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
          : "Couldn’t check for updates."
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

  const handleUpdate = async (tag: string) => {
    setUpdateError(null);
    let res: Response;
    try {
      res = await fetch("/api/v1/release/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
    } catch (error) {
      setUpdateError(cleanError(errorMessage(error)));
      return;
    }
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setUpdateError(cleanError(err.error ?? "Couldn’t start the update."));
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

  const updateJob = job?.jobType === "update" ? job : null;
  const isDone =
    updateJob?.phase === "done" ||
    (!postRestartPolling &&
      updateJob?.phase === "restarting" &&
      status?.tag === updateJob?.tag);
  const isFailed = updateJob?.phase === "failed";
  const isRestarting =
    updateJob?.phase === "restarting" ||
    (updateJob !== null && postRestartPolling);
  const showTakeover = updateJob !== null;

  return {
    status,
    infoProgress,
    postRestartPolling,

    versionInfo,
    versionInfoError: versionQuery.isError,
    retryVersionInfo: () => void versionQuery.refetch(),
    notesExpanded,
    setNotesExpanded,
    channel: shownChannel,
    channelStatus: channelSave.status("channel"),
    autoUpdateMode: modeSave.value("mode", autoUpdateMode),
    autoUpdateStatus: modeSave.status("mode"),
    infoLoading,
    infoError,
    preferencesError,
    updateError,
    lastCheckMessage,

    displayInfo,

    updateJob,
    isDone,
    isFailed,
    isRestarting,
    showTakeover,

    handleAutoUpdateModeChange,
    handleChannelChange,
    handleCheckForUpdates,
    handleUpdate,
    handleReload,
    handleClearCacheAndReload,
    handleDismiss,
  };
}
