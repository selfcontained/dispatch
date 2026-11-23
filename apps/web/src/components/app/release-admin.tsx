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
import { ApiError } from "@/lib/api";

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
    releasesError,
    promotingTag,
    promotionUrl,
    confirmPromoteTag,
    promoteError,
    setConfirmPromoteTag,
    refresh,
    promote,
  } = useReleaseAdminData(streamClientId);

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
    const res = await fetch("/api/v1/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionType }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      throw new ApiError(
        res.status,
        cleanError(err.error ?? "The release didn’t start.")
      );
    }
    setConfirmType(null);
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
  };

  // Expanded progress view — jump in and out freely; the release keeps
  // running server-side either way.
  if (showProgress && createJob) {
    return (
      <div className="flex h-[70dvh] min-h-96 flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowProgress(false)}
          >
            <ArrowLeft />
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
    <div className="space-y-8">
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
        releaseInFlight={releaseInFlight}
        confirmType={confirmType}
        onConfirmTypeChange={setConfirmType}
        onRelease={handleRelease}
      />

      <RecentReleases
        releases={releases}
        releasesLoading={releasesLoading}
        releasesError={releasesError}
        onRetry={refresh}
        promoteError={promoteError}
        promotingTag={promotingTag}
        promotionUrl={promotionUrl}
        confirmPromoteTag={confirmPromoteTag}
        onConfirmPromoteTagChange={setConfirmPromoteTag}
        onPromote={promote}
      />
    </div>
  );
}
