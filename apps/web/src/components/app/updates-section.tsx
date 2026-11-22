import { EngineUpdatesCard } from "@/components/app/engine-updates-card";
import { MacAppUpdatesCard } from "@/components/app/mac-app-updates-card";
import { OperationTakeover } from "@/components/app/release-operation-takeover";
import { UpdatesCheckPanel } from "@/components/app/updates-check-panel";
import { UpdatesPreferences } from "@/components/app/updates-preferences";
import { UpdatesReloadCard } from "@/components/app/updates-reload-card";
import { UpdatesVersionCard } from "@/components/app/updates-version-card";
import type { UseReleaseStreamResult } from "@/hooks/use-release-stream";
import { useReleaseUpdates } from "@/hooks/use-release-updates";
import { UPDATE_PHASES } from "./release-utils";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

type UpdatesSectionProps = {
  stream: UseReleaseStreamResult;
};

export function UpdatesSection({ stream }: UpdatesSectionProps): JSX.Element {
  const {
    status,
    infoProgress,
    postRestartPolling,

    versionInfo,
    versionInfoError,
    retryVersionInfo,
    notesExpanded,
    setNotesExpanded,
    channel,
    channelSaving,
    autoUpdateMode,
    autoUpdateSaving,
    infoLoading,
    infoError,
    updateError,
    preferencesError,
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
  } = useReleaseUpdates(stream);

  if (showTakeover) {
    return (
      <OperationTakeover
        job={updateJob!}
        phasesOrder={[...UPDATE_PHASES]}
        isDone={isDone}
        isFailed={isFailed}
        isRestarting={isRestarting}
        postRestartPolling={postRestartPolling}
        status={status}
        onDismiss={handleDismiss}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <UpdatesVersionCard
        status={status}
        versionInfo={versionInfo}
        notesExpanded={notesExpanded}
        onToggleNotes={() => setNotesExpanded(!notesExpanded)}
      />

      <div className="border-t border-edge" />

      {!versionInfo ? (
        versionInfoError ? (
          <LoadError
            thing="update settings"
            error={versionInfoError}
            onRetry={retryVersionInfo}
          />
        ) : (
          <LoadingSkeleton
            label="Loading update settings…"
            rowClassName="h-16"
            rows={2}
          />
        )
      ) : versionInfo.updateOwner === "macos-app" ? (
        <MacAppUpdatesCard />
      ) : (
        <>
          <UpdatesPreferences
            channel={channel}
            channelSaving={channelSaving}
            onChannelChange={(ch) => void handleChannelChange(ch)}
            autoUpdateMode={autoUpdateMode}
            autoUpdateSaving={autoUpdateSaving}
            onAutoUpdateModeChange={(mode) =>
              void handleAutoUpdateModeChange(mode)
            }
          />

          {preferencesError ? <Alert {...preferencesError} /> : null}

          <UpdatesCheckPanel
            infoLoading={infoLoading}
            infoProgress={infoProgress}
            infoError={infoError}
            lastCheckMessage={lastCheckMessage}
            displayInfo={displayInfo}
            updateError={updateError}
            onCheckForUpdates={() => void handleCheckForUpdates()}
            onUpdate={(tag) => void handleUpdate(tag)}
          />
        </>
      )}

      <div className="border-t border-edge" />

      <EngineUpdatesCard />

      <UpdatesReloadCard
        onReload={handleReload}
        onClearCacheAndReload={() => void handleClearCacheAndReload()}
      />
    </div>
  );
}
