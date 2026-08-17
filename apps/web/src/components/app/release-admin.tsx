import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ReleaseJobBanners } from "@/components/app/release-admin-banners";
import { CreateReleaseSection } from "@/components/app/release-admin-create";
import { RecentReleases } from "@/components/app/release-admin-list";
import { UnreleasedChanges } from "@/components/app/release-admin-unreleased";
import { OperationTakeover } from "@/components/app/release-operation-takeover";
import { CREATE_PHASES, cleanError } from "@/components/app/release-utils";
import { useReleaseAdminData } from "@/components/app/use-release-admin-data";
import { Button } from "@/components/ui/button";
import type { ReleaseVersionType } from "@/hooks/use-release-stream";
import { useReleaseStream } from "@/hooks/use-release-stream";

export function ReleasesAdmin(): JSX.Element {
  const stream = useReleaseStream("create");
  const {
    job,
    postRestartPolling,
    connectStream,
    setJob,
    status,
    infoProgress,
    streamClientId,
  } = stream;

  const {
    info,
    infoLoading,
    infoError,
    lastCheckedAt,
    now,
    releases,
    releasesLoading,
    promotingTag,
    confirmPromoteTag,
    promoteError,
    setConfirmPromoteTag,
    refresh,
    promote,
  } = useReleaseAdminData(streamClientId);

  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [confirmType, setConfirmType] = useState<ReleaseVersionType | null>(
    null
  );
  const [showProgress, setShowProgress] = useState(false);

  const createJob = job?.jobType === "create" ? job : null;
  const isDone = createJob?.phase === "done";
  const isFailed = createJob?.phase === "failed";
  const releaseInFlight = createJob !== null && !isDone && !isFailed;

  // Distinguish a release we watched run from a stale done job that
  // persists in server memory and arrives via the stream snapshot.
  // State (not a ref): the done banner is rendered from this value, and
  // stream events can land back-to-back so the done render may commit
  // before a ref written in an effect would be visible.
  const [watchedRelease, setWatchedRelease] = useState(false);
  useEffect(() => {
    if (releaseInFlight) setWatchedRelease(true);
  }, [releaseInFlight]);

  // When a release we watched finishes, refresh so the just-released
  // commits leave the unreleased list without a manual reload.
  const handledDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      isDone &&
      watchedRelease &&
      createJob &&
      handledDoneRef.current !== createJob.startedAt
    ) {
      handledDoneRef.current = createJob.startedAt;
      refresh();
    }
  }, [isDone, watchedRelease, createJob, refresh]);

  const handleRelease = async (versionType: ReleaseVersionType) => {
    setReleaseError(null);
    setConfirmType(null);
    const res = await fetch("/api/v1/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionType }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setReleaseError(cleanError(err.error ?? "Failed to start release"));
      return;
    }
    setJob({
      jobType: "create",
      versionType,
      phase: "preflight",
      startedAt: new Date().toISOString(),
      log: [],
      runUrl: null,
      tag: null,
      error: null,
      progress: null,
    });
    connectStream();
    setShowProgress(true);
  };

  // The most recent GitHub release (prereleases included) is what the
  // release workflow bumps from; fall back to the deployed tag.
  const bumpBase = releases[0]?.tag ?? info?.currentTag ?? null;

  const dismissJob = () => {
    setJob(null);
    setShowProgress(false);
    setWatchedRelease(false);
    setReleaseError(null);
  };

  // Expanded progress view — jump in and out freely; the release keeps
  // running server-side either way.
  if (showProgress && createJob) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-white/[0.12] px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowProgress(false)}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to releases
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <OperationTakeover
            job={createJob}
            phasesOrder={[...CREATE_PHASES]}
            isDone={isDone}
            isFailed={isFailed}
            isRestarting={false}
            postRestartPolling={postRestartPolling}
            status={status}
            onDismiss={dismissJob}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* In-flight / finished release banner — page stays usable */}
      {createJob && (
        <ReleaseJobBanners
          job={createJob}
          releaseInFlight={releaseInFlight}
          isFailed={isFailed}
          isDone={isDone}
          watchedRelease={watchedRelease}
          onShowProgress={() => setShowProgress(true)}
          onDismiss={dismissJob}
        />
      )}

      <UnreleasedChanges
        info={info}
        infoLoading={infoLoading}
        infoError={infoError}
        infoProgress={infoProgress}
        lastCheckedAt={lastCheckedAt}
        now={now}
        onRefresh={refresh}
      />

      <CreateReleaseSection
        info={info}
        bumpBase={bumpBase}
        releaseError={releaseError}
        releaseInFlight={releaseInFlight}
        confirmType={confirmType}
        onConfirmTypeChange={setConfirmType}
        onRelease={(versionType) => void handleRelease(versionType)}
      />

      <div className="border-t border-white/[0.12]" />

      <RecentReleases
        releases={releases}
        releasesLoading={releasesLoading}
        promoteError={promoteError}
        promotingTag={promotingTag}
        confirmPromoteTag={confirmPromoteTag}
        onConfirmPromoteTagChange={setConfirmPromoteTag}
        onPromote={(tag) => void promote(tag)}
      />
    </div>
  );
}
