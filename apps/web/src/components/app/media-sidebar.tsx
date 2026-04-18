import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  MonitorPlay,
  X,
  Image,
  File as FileIcon,
  Video,
  Upload,
  User,
} from "lucide-react";
import { useAtom } from "jotai";

import { type AgentPin, type MediaFile } from "@/components/app/types";
import { mediaSidebarTabAtom } from "@/lib/store";
import {
  MediaActions,
  isTextFile,
  stripTimestamp,
} from "@/components/app/media-lightbox";
import { PinsPanel } from "@/components/app/pins-panel";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ACCEPTED_EXTENSIONS =
  ".png,.jpg,.jpeg,.gif,.webp,.mp4,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.sh,.sql,.diff,.patch,.env,.ini,.cfg,.conf,.swift,.kt,.java,.c,.cpp,.h,.hpp,.rb,.php,.lua,.zig,.nim,.r,.m,.ex,.exs,.erl,.hs";

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

type MediaSidebarSharedProps = {
  mediaFiles: MediaFile[];
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  selectedAgentWorkspaceRoot: string | null;
  selectedAgentPins: AgentPin[];
  animatingMediaKeys: Set<string>;
  mediaViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (file: MediaFile) => void;
  hasStream: boolean;
  streamUrl: string | null;
  unseenMediaCount: number;
  onUploadFile?: (agentId: string, file: File) => Promise<void>;
};

type MediaSidebarProps = MediaSidebarSharedProps & {
  mediaOpen: boolean;
  setMediaOpen: (open: boolean) => void;
};

type MediaSidebarContentProps = MediaSidebarSharedProps & {
  onRequestClose?: () => void;
  closeButtonIcon?: "chevron" | "x";
  className?: string;
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

function MediaContent({
  mediaFiles,
  selectedAgentId,
  animatingMediaKeys,
  mediaViewportRef,
  openLightbox,
  hasStream,
  streamUrl,
  onUploadFile,
}: Pick<
  MediaSidebarSharedProps,
  | "mediaFiles"
  | "selectedAgentId"
  | "animatingMediaKeys"
  | "mediaViewportRef"
  | "openLightbox"
  | "hasStream"
  | "streamUrl"
  | "onUploadFile"
>): JSX.Element {
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
      // Reset input so the same file can be re-uploaded
      e.target.value = "";
    },
    [selectedAgentId, onUploadFile]
  );

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <>
      {hasStream && streamUrl && selectedAgentId ? (
        <LiveStreamSection
          streamUrl={streamUrl}
          selectedAgentId={selectedAgentId}
        />
      ) : null}

      {/* Upload button bar */}
      {selectedAgentId && onUploadFile ? (
        <div className="border-b-2 border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ACCEPTED_EXTENSIONS}
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
        {mediaFiles.length === 0 && !hasStream ? (
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
        ) : mediaFiles.length === 0 ? null : (
          mediaFiles.map((file) => {
            const mediaKey = `${file.name}:${file.updatedAt}`;
            const cacheBustUrl = `${file.url}?t=${encodeURIComponent(file.updatedAt)}`;
            const animating = animatingMediaKeys.has(mediaKey);
            const unseen = !file.seen;

            const isStream = file.source === "stream";
            const isText = file.source === "text" || isTextFile(file.name);
            const isDocument = /\.pdf$/i.test(file.name);
            const isUser = file.source === "user";

            return (
              <article
                key={mediaKey}
                data-media-key={mediaKey}
                className={cn(
                  "border-b-2 border-border px-3 py-3",
                  isStream &&
                    "border-l-2 border-l-status-blocked/60 bg-status-blocked/5",
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
                        {fileExtension(file.name)}
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
          })
        )}
      </div>
    </>
  );
}

export function MediaSidebarContent({
  mediaFiles,
  selectedAgentId,
  selectedAgentName,
  selectedAgentWorkspaceRoot,
  selectedAgentPins,
  animatingMediaKeys,
  mediaViewportRef,
  openLightbox,
  hasStream,
  streamUrl,
  onRequestClose,
  closeButtonIcon = "x",
  className,
  unseenMediaCount,
  onUploadFile,
}: MediaSidebarContentProps & { unseenMediaCount: number }): JSX.Element {
  const [activeTab, setActiveTab] = useAtom(mediaSidebarTabAtom);
  const prevAgentIdRef = useRef(selectedAgentId);

  // Reset to pins tab when agent changes
  if (prevAgentIdRef.current !== selectedAgentId) {
    prevAgentIdRef.current = selectedAgentId;
    if (activeTab !== "pins") {
      setActiveTab("pins");
    }
  }

  return (
    <aside
      data-testid="media-sidebar"
      className={cn(
        "flex h-full min-h-0 w-full flex-col border-l border-white/[0.12] bg-[hsl(var(--card))] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        className
      )}
    >
      {/* Tab header */}
      <div className="flex min-h-14 items-center pt-[env(safe-area-inset-top)]">
        <div className="flex flex-1">
          <button
            onClick={() => setActiveTab("pins")}
            className={cn(
              "relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "pins"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Pins
            {activeTab === "pins" ? (
              <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-foreground" />
            ) : null}
            {selectedAgentPins.length > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[8px] text-primary-foreground">
                {selectedAgentPins.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("media")}
            className={cn(
              "relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "media"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Media
            {activeTab === "media" ? (
              <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-foreground" />
            ) : null}
            {unseenMediaCount > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[8px] text-destructive-foreground">
                {unseenMediaCount}
              </span>
            )}
          </button>
        </div>
        {onRequestClose ? (
          <div className="px-2">
            <Button
              size="icon"
              variant="ghost"
              onClick={onRequestClose}
              title="Close sidebar"
              className="h-7 w-7"
            >
              {closeButtonIcon === "chevron" ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <X className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Tab content — both panels stay mounted so refs (e.g. IntersectionObserver) remain attached */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "pins" && "hidden"
        )}
      >
        <PinsPanel
          pins={selectedAgentPins}
          selectedAgentName={selectedAgentName}
          selectedAgentWorkspaceRoot={selectedAgentWorkspaceRoot}
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "media" && "hidden"
        )}
      >
        <MediaContent
          mediaFiles={mediaFiles}
          selectedAgentId={selectedAgentId}
          animatingMediaKeys={animatingMediaKeys}
          mediaViewportRef={mediaViewportRef}
          openLightbox={openLightbox}
          hasStream={hasStream}
          streamUrl={streamUrl}
          onUploadFile={onUploadFile}
        />
      </div>
    </aside>
  );
}

export function MediaSidebar({
  mediaOpen,
  setMediaOpen,
  hasStream,
  ...props
}: MediaSidebarProps): JSX.Element {
  // Auto-open the sidebar when a stream starts so the user doesn't miss it
  useEffect(() => {
    if (hasStream) {
      setMediaOpen(true);
    }
  }, [hasStream, setMediaOpen]);

  return (
    <div
      className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: mediaOpen ? 360 : 0 }}
    >
      <MediaSidebarContent
        {...props}
        hasStream={hasStream}
        onRequestClose={() => setMediaOpen(false)}
        closeButtonIcon="chevron"
        className="w-[360px]"
      />
    </div>
  );
}
