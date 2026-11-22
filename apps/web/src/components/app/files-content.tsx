import { type RefObject, useCallback, useRef, useState } from "react";
import { Check, ExternalLink, Files, Upload } from "lucide-react";

import { type FileItem, type SubAgentFiles } from "@/components/app/types";
import { FileCardList } from "@/components/app/file-item-card";
import { OwnerSwitch } from "@/components/app/owner-switch";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { STARTUP_FILE_ACCEPT } from "@/lib/file-accept";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";

const EMPTY_SUB_AGENT_FILES: SubAgentFiles[] = [];

/** Where the selected agent's own list stands. */
export type FilesState = {
  error: unknown;
  loading: boolean;
  retry: () => void;
};

export type FilesContentProps = {
  filesState?: FilesState;
  /** The files to show: the selected agent's own, or the chosen sub agent's. */
  files: FileItem[];
  /**
   * The selected agent's direct children and their files. When present, an
   * owner dropdown at the top of the tab picks whose files show, the same
   * control the Pins tab uses. Inline per-child groups below the agent's own
   * files were tried and rejected for the same reason as on Pins: their
   * position depended on how much came before them.
   */
  subAgentFiles?: SubAgentFiles[];
  /** The selected agent's own files, for the dropdown's counts while a sub agent is shown. */
  ownFiles?: FileItem[];
  /** null = the selected agent's own files. */
  filesOwnerId?: string | null;
  onFilesOwnerChange?: (ownerId: string | null) => void;
  selectedAgentId: string | null;
  selectedAgentName?: string | null;
  animatingFileKeys: Set<string>;
  drawerViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (fileId: number) => void;
  hasStream: boolean;
  streamUrl: string | null;
  onUploadFile?: (agentId: string, file: File) => Promise<void>;
  /** Whether the tab is showing; file media loads only once it is. */
  active: boolean;
};

function LiveStreamSection({
  streamUrl,
  selectedAgentId,
}: {
  streamUrl: string;
  selectedAgentId: string;
}): JSX.Element {
  const popOut = useCallback(() => {
    window.open(
      `/api/v1/agents/${selectedAgentId}/stream/viewer`,
      `stream-${selectedAgentId}`,
      "width=1300,height=860,menubar=no,toolbar=no,location=no,status=no"
    );
  }, [selectedAgentId]);

  return (
    <div className="border-b-2 border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusDot tone="danger" className="animate-pulse" />
        <span className="section-label text-danger">Live Stream</span>
        <div className="ml-auto">
          <Button size="xs" variant="ghost" onClick={popOut}>
            <ExternalLink />
            Pop out
          </Button>
        </div>
      </div>
      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded-sm border border-border bg-media">
          <img
            src={streamUrl}
            alt="Live browser stream"
            className="w-full object-contain"
          />
        </div>
      </div>
    </div>
  );
}

export function FilesContent({
  files,
  filesState,
  subAgentFiles = EMPTY_SUB_AGENT_FILES,
  ownFiles = files,
  filesOwnerId = null,
  onFilesOwnerChange,
  selectedAgentId,
  selectedAgentName = null,
  animatingFileKeys,
  drawerViewportRef,
  openLightbox,
  hasStream,
  streamUrl,
  onUploadFile,
  active,
}: FilesContentProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>();
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const successTimerRef = useRef<number | null>(null);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !selectedAgentId || !onUploadFile) return;
      setUploading(true);
      setUploadError(undefined);
      setUploadSuccess(false);
      try {
        await onUploadFile(selectedAgentId, file);
        setUploadSuccess(true);
        if (successTimerRef.current)
          window.clearTimeout(successTimerRef.current);
        successTimerRef.current = window.setTimeout(() => {
          setUploadSuccess(false);
          successTimerRef.current = null;
        }, 4000);
      } catch (err) {
        setUploadError(err);
      } finally {
        setUploading(false);
      }
      e.target.value = "";
    },
    [selectedAgentId, onUploadFile]
  );

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const viewingSubAgent = filesOwnerId !== null;
  const viewedSubAgent = viewingSubAgent
    ? (subAgentFiles.find((group) => group.agent.id === filesOwnerId) ?? null)
    : null;
  const ownSummary = {
    count: ownFiles.length,
    unseen: ownFiles.filter((file) => !file.seen).length,
  };
  // The parent's stream is hidden while a sub agent is shown, so it only
  // counts as content in the parent's own view.
  const ownState = viewingSubAgent ? undefined : filesState;
  const nothingShared = files.length === 0 && (viewingSubAgent || !hasStream);

  return (
    <>
      {subAgentFiles.length > 0 && onFilesOwnerChange ? (
        <OwnerSwitch
          testIdPrefix="files-owner"
          ariaLabel="Whose files to show"
          itemNoun={["file", "files"]}
          selectedAgentId={selectedAgentId}
          selectedAgentName={selectedAgentName}
          own={ownSummary}
          subAgents={subAgentFiles.map((group) => ({
            agent: group.agent,
            count: group.files.length,
            unseen: group.files.filter((f) => !f.seen).length,
          }))}
          viewOwnerId={filesOwnerId}
          onChange={onFilesOwnerChange}
        />
      ) : null}
      {/* Stream and upload belong to the selected agent; a sub agent's files
          are read-only from here. */}
      {!viewingSubAgent && hasStream && streamUrl && selectedAgentId ? (
        <LiveStreamSection
          streamUrl={streamUrl}
          selectedAgentId={selectedAgentId}
        />
      ) : null}

      {!viewingSubAgent && selectedAgentId && onUploadFile ? (
        <div className="border-b-2 border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={STARTUP_FILE_ACCEPT}
              onChange={handleFileChange}
            />
            <Button size="xs" pending={uploading} onClick={triggerFilePicker}>
              {uploadSuccess ? <Check /> : <Upload />}
              {uploadSuccess ? "Shared" : "Share file"}
            </Button>
          </div>
          {uploadError ? (
            <Alert
              title="Couldn’t share the file."
              error={uploadError}
              className="mt-2"
              onDismiss={() => setUploadError(undefined)}
            />
          ) : null}
          {uploadSuccess ? (
            <p className="mt-1 text-label-sm text-muted-foreground">
              Tell the agent about the file so it knows to look.
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        ref={drawerViewportRef}
        data-testid="files-panel-scroll"
        className="min-h-0 flex-1 overflow-y-auto pb-safe"
      >
        {ownState?.error ? (
          <LoadError
            thing="files"
            error={ownState.error}
            onRetry={ownState.retry}
            className="m-3"
          />
        ) : null}
        {nothingShared ? (
          ownState?.error ? null : ownState?.loading ||
            viewedSubAgent?.status === "pending" ? (
            <LoadingSkeleton
              label={
                viewedSubAgent
                  ? `Loading ${viewedSubAgent.agent.name}'s files…`
                  : "Loading files…"
              }
              className="w-auto p-3"
              rowClassName="h-24"
              rows={2}
            />
          ) : (
            <div className="flex h-full flex-col">
              {viewedSubAgent?.status === "error" ? (
                <Alert
                  title={`Couldn’t load ${viewedSubAgent.agent.name}’s files.`}
                  className="m-3"
                  action={
                    viewedSubAgent.retry
                      ? { label: "Retry", onClick: viewedSubAgent.retry }
                      : undefined
                  }
                />
              ) : (
                <EmptyState
                  icon={Files}
                  title={
                    viewedSubAgent
                      ? `${viewedSubAgent.agent.name} has not shared any files yet.`
                      : selectedAgentId
                        ? "No files yet."
                        : "Focus an agent to view files."
                  }
                  description={
                    !viewedSubAgent && selectedAgentId
                      ? "Screenshots, videos and documents agents share show up here."
                      : undefined
                  }
                  action={
                    !viewedSubAgent && selectedAgentId && onUploadFile ? (
                      <Button size="sm" onClick={triggerFilePicker}>
                        Share a file
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
          )
        ) : (
          <FileCardList
            files={files}
            animatingFileKeys={animatingFileKeys}
            openLightbox={openLightbox}
            active={active}
          />
        )}
      </div>
    </>
  );
}
