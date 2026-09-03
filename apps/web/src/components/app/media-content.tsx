import { type RefObject, useCallback, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  Image,
  Upload,
  File as FileIcon,
  Video,
} from "lucide-react";

import { type MediaFile, type SubAgentMedia } from "@/components/app/types";
import { MediaCardList } from "@/components/app/media-item-card";
import { SubAgentMediaGroup } from "@/components/app/sub-agent-media-group";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { STARTUP_FILE_ACCEPT } from "@/lib/media-accept";

const EMPTY_SUB_AGENT_MEDIA: SubAgentMedia[] = [];

export type MediaContentProps = {
  mediaFiles: MediaFile[];
  /**
   * The selected agent's direct children and their media, rendered as one
   * expanded group each after the agent's own files. Children with nothing
   * shared are left out rather than shown as empty headings.
   */
  subAgentMedia?: SubAgentMedia[];
  selectedAgentId: string | null;
  animatingMediaKeys: Set<string>;
  mediaViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (file: MediaFile) => void;
  hasStream: boolean;
  streamUrl: string | null;
  onUploadFile?: (agentId: string, file: File) => Promise<void>;
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
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-status-blocked" />
        <span className="text-xs font-semibold uppercase tracking-wide text-status-blocked">
          Live Stream
        </span>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            onClick={popOut}
          >
            <ExternalLink className="h-3 w-3" />
            Pop out
          </Button>
        </div>
      </div>
      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded border border-border bg-black">
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

export function MediaContent({
  mediaFiles,
  subAgentMedia = EMPTY_SUB_AGENT_MEDIA,
  selectedAgentId,
  animatingMediaKeys,
  mediaViewportRef,
  openLightbox,
  hasStream,
  streamUrl,
  onUploadFile,
}: MediaContentProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const successTimerRef = useRef<number | null>(null);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !selectedAgentId || !onUploadFile) return;
      setUploading(true);
      setUploadError(null);
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
        setUploadError(err instanceof Error ? err.message : "Upload failed");
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

  const subAgentGroups = subAgentMedia.filter(
    (group) => group.files.length > 0
  );
  const nothingShared =
    mediaFiles.length === 0 && subAgentGroups.length === 0 && !hasStream;

  return (
    <>
      {hasStream && streamUrl && selectedAgentId ? (
        <LiveStreamSection
          streamUrl={streamUrl}
          selectedAgentId={selectedAgentId}
        />
      ) : null}

      {selectedAgentId && onUploadFile ? (
        <div className="border-b-2 border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={STARTUP_FILE_ACCEPT}
              onChange={handleFileChange}
            />
            <Button
              size="sm"
              variant="default"
              className="h-7 gap-1.5 text-xs"
              disabled={uploading}
              onClick={triggerFilePicker}
            >
              {uploading ? (
                <ActivityBars size={12} />
              ) : uploadSuccess ? (
                <Check className="h-3 w-3" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              {uploading
                ? "Uploading…"
                : uploadSuccess
                  ? "Shared"
                  : "Share file"}
            </Button>
            {uploadError ? (
              <span className="truncate text-xs text-destructive">
                {uploadError}
              </span>
            ) : null}
          </div>
          {uploadSuccess ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Tell the agent about the file so it knows to look.
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        ref={mediaViewportRef}
        data-testid="media-panel-scroll"
        className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
      >
        {nothingShared ? (
          <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-8">
                <Image className="h-8 w-8 text-muted-foreground" />
                <Video className="h-8 w-8 text-muted-foreground" />
                <FileIcon className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="mt-4">
                {selectedAgentId ? (
                  <>
                    No media yet.{" "}
                    <button
                      className="underline hover:text-foreground"
                      onClick={triggerFilePicker}
                    >
                      Share a file
                    </button>{" "}
                    or wait for agents to share screenshots, videos and
                    documents.
                  </>
                ) : (
                  "Focus an agent to view media."
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            <MediaCardList
              files={mediaFiles}
              animatingMediaKeys={animatingMediaKeys}
              openLightbox={openLightbox}
            />
            {selectedAgentId
              ? subAgentGroups.map((group) => (
                  <SubAgentMediaGroup
                    key={group.agent.id}
                    group={group}
                    collapseScope={selectedAgentId}
                    animatingMediaKeys={animatingMediaKeys}
                    openLightbox={openLightbox}
                  />
                ))
              : null}
          </>
        )}
      </div>
    </>
  );
}
