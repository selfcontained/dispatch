import { AssistedUpdateProgress } from "@/components/app/assisted-update-progress";
import { OperationTakeover } from "@/components/app/release-operation-takeover";
import { UpdatesCheckPanel } from "@/components/app/updates-check-panel";
import { UpdatesForceConfirmDialog } from "@/components/app/updates-force-confirm-dialog";
import { UpdatesPreferences } from "@/components/app/updates-preferences";
import { UpdatesReloadCard } from "@/components/app/updates-reload-card";
import { UpdatesVersionCard } from "@/components/app/updates-version-card";
import type { UseReleaseStreamResult } from "@/hooks/use-release-stream";
import { useReleaseUpdates } from "@/hooks/use-release-updates";
import { UPDATE_PHASES } from "./release-utils";

type UpdatesSectionProps = {
  stream: UseReleaseStreamResult;
};

export function UpdatesSection({ stream }: UpdatesSectionProps): JSX.Element {
  const {
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
  } = useReleaseUpdates(stream);

  if (assistedJob) {
    return (
      <AssistedUpdateProgress
        job={assistedJob}
        onDismiss={handleAssistedDismiss}
      />
    );
  }

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

      <div className="border-t border-white/[0.12]" />

      <UpdatesPreferences
        channel={channel}
        channelSaving={channelSaving}
        onChannelChange={(ch) => void handleChannelChange(ch)}
        autoUpdateMode={autoUpdateMode}
        autoUpdateSaving={autoUpdateSaving}
        onAutoUpdateModeChange={(mode) => void handleAutoUpdateModeChange(mode)}
      />

      <UpdatesCheckPanel
        infoLoading={infoLoading}
        infoProgress={infoProgress}
        infoError={infoError}
        lastCheckMessage={lastCheckMessage}
        displayInfo={displayInfo}
        updateError={updateError}
        assistedUpdateLaunching={assistedUpdateLaunching}
        onCheckForUpdates={() => void handleCheckForUpdates()}
        onStandardUpdate={(tag) => void handleUpdate(tag)}
        onAssistedUpdate={(tag) => void handleAssistedUpdate(tag)}
        onForceStandardUpdate={() => setForceConfirmOpen(true)}
      />

      <div className="border-t border-white/[0.12]" />

      <UpdatesReloadCard
        onReload={handleReload}
        onClearCacheAndReload={() => void handleClearCacheAndReload()}
      />

      <UpdatesForceConfirmDialog
        open={forceConfirmOpen}
        onOpenChange={setForceConfirmOpen}
        displayInfo={displayInfo}
        onConfirm={(tag) => void handleUpdate(tag, { force: true })}
      />
    </div>
  );
}
