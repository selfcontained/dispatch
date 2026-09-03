import { type RefObject, useCallback, useId, useRef, useState } from "react";
import { useAtom } from "jotai";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Image,
  MonitorPlay,
  Upload,
  User,
  File as FileIcon,
  Video,
} from "lucide-react";

import { type MediaFile, type SubAgentMedia } from "@/components/app/types";
import { MediaActions } from "@/components/app/media-lightbox";
import {
  fileExtension,
  isTextFile,
  stripTimestamp,
} from "@/components/app/media-file-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { mediaGroupCollapsedAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";
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

function MediaItemCard({
  file,
  animating,
  cacheBustUrl,
  openLightbox,
}: {
  file: MediaFile;
  animating: boolean;
  cacheBustUrl: string;
  openLightbox: (file: MediaFile) => void;
}): JSX.Element {
  const isStream = file.source === "stream";
  const isText = file.source === "text" || isTextFile(file.name);
  const isDocument = /\.pdf$/i.test(file.name);
  const isUser = file.source === "user";
  const unseen = !file.seen;

  return (
    <article
      data-media-key={`${file.name}:${file.updatedAt}`}
      // Whose file this is, so seen-tracking posts to the owning agent when
      // the card scrolls into view inside a parent's panel.
      data-media-owner={file.ownerAgentId}
      className={cn(
        "border-b-2 border-border px-3 py-3",
        isStream && "border-l-2 border-l-status-blocked/60 bg-status-blocked/5",
        animating && "animate-media-in-slow"
      )}
    >
      {isStream ? (
        <div className="mb-2 flex items-center gap-1.5">
          <MonitorPlay className="h-3.5 w-3.5 text-status-blocked" />
          <span className="text-xs font-semibold uppercase tracking-wide text-status-blocked">
            Stream recording
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {new Date(file.updatedAt).toLocaleString()}
          </span>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{new Date(file.updatedAt).toLocaleString()}</span>
          {isUser ? (
            <span className="ml-auto flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <User className="h-2.5 w-2.5" />
              Shared by you
            </span>
          ) : null}
        </div>
      )}
      {isText || isDocument ? (
        <button
          className={cn(
            "block w-full overflow-hidden rounded border-2 bg-muted/50 p-3 text-left",
            unseen ? "media-thumb-unseen" : "media-thumb-seen"
          )}
          onClick={() => openLightbox(file)}
        >
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 flex-none text-muted-foreground" />
            <span className="truncate text-xs font-medium text-foreground">
              {stripTimestamp(file.name)}
            </span>
            <span className="ml-auto flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {fileExtension(file.name).replace(".", "")}
            </span>
          </div>
        </button>
      ) : /\.mp4$/i.test(file.name) ? (
        <div
          className={cn(
            "block w-full overflow-hidden border-2 bg-black/60",
            unseen ? "media-thumb-unseen" : "media-thumb-seen"
          )}
        >
          <video
            src={cacheBustUrl}
            controls
            muted
            playsInline
            preload="metadata"
            className="max-h-[260px] w-full object-contain"
          />
        </div>
      ) : (
        <button
          className={cn(
            "block w-full overflow-hidden border-2 bg-black/60",
            unseen ? "media-thumb-unseen" : "media-thumb-seen"
          )}
          onClick={() => openLightbox(file)}
        >
          <img
            src={cacheBustUrl}
            alt={file.description || ""}
            className="max-h-[260px] w-full object-contain"
          />
        </button>
      )}
      <div className="mt-2 text-xs text-muted-foreground">
        {file.description ? <div>{file.description}</div> : null}
        <div
          className={`flex items-center justify-between gap-2${file.description ? " mt-1" : ""}`}
        >
          <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
          <MediaActions
            src={cacheBustUrl}
            fileName={file.name}
            isText={isText}
          />
        </div>
      </div>
    </article>
  );
}

function renderMediaCards(
  files: MediaFile[],
  animatingMediaKeys: Set<string>,
  openLightbox: (file: MediaFile) => void
): JSX.Element[] {
  return files.map((file) => {
    const mediaKey = `${file.name}:${file.updatedAt}`;
    const cacheBustUrl = `${file.url}?t=${encodeURIComponent(file.updatedAt)}`;
    return (
      <MediaItemCard
        key={`${file.ownerAgentId ?? ""}/${mediaKey}`}
        file={file}
        animating={animatingMediaKeys.has(
          `${file.ownerAgentId ?? ""}/${mediaKey}`
        )}
        cacheBustUrl={cacheBustUrl}
        openLightbox={openLightbox}
      />
    );
  });
}

/**
 * One sub agent's media under its parent. Expanded by default — screenshots
 * are the point of the tab — with the choice persisted per parent/child pair
 * so it survives a rename. Members stay mounted while collapsed: the seen
 * observer keys off the cards, and unmounting would drop an in-flight
 * "seen" for a file the user had just scrolled past.
 */
function SubAgentMediaGroup({
  group,
  collapseScope,
  animatingMediaKeys,
  openLightbox,
}: {
  group: SubAgentMedia;
  collapseScope: string;
  animatingMediaKeys: Set<string>;
  openLightbox: (file: MediaFile) => void;
}): JSX.Element {
  const [choice, setChoice] = useAtom(
    mediaGroupCollapsedAtomFamily(`${collapseScope}::${group.agent.id}`)
  );
  const collapsed = choice ?? false;
  const unseen = group.files.filter((file) => !file.seen).length;
  const uid = useId();
  const headingId = `media-group-${uid}`;
  const regionId = `media-group-members-${uid}`;

  return (
    <section
      data-testid="sub-agent-media-group"
      data-sub-agent-id={group.agent.id}
      data-media-group-collapsed={collapsed ? "true" : "false"}
      aria-labelledby={headingId}
    >
      <button
        type="button"
        onClick={() => setChoice(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls={regionId}
        data-testid="sub-agent-media-toggle"
        className="flex w-full items-center gap-1.5 border-b-2 border-border bg-muted/40 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            !collapsed && "rotate-90"
          )}
          aria-hidden
        />
        <span id={headingId} className="min-w-0 flex-1 truncate normal-case">
          {group.agent.name}
        </span>
        {unseen > 0 ? (
          <span
            className="shrink-0 rounded-full bg-destructive px-1.5 text-[10px] font-semibold tabular-nums text-destructive-foreground"
            data-testid="sub-agent-media-unseen"
          >
            {unseen}
          </span>
        ) : null}
        <span
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums"
          data-testid="sub-agent-media-count"
        >
          {group.files.length}
        </span>
      </button>
      <div id={regionId} hidden={collapsed}>
        {renderMediaCards(group.files, animatingMediaKeys, openLightbox)}
      </div>
    </section>
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
            {renderMediaCards(mediaFiles, animatingMediaKeys, openLightbox)}
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
