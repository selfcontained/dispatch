import { type RefObject, useCallback, useEffect } from "react";
import { ChevronRight, ExternalLink, X } from "lucide-react";

import { type MediaFile } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MediaSidebarSharedProps = {
  mediaFiles: MediaFile[];
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  animatingMediaKeys: Set<string>;
  seenMediaKeys: Set<string>;
  mediaViewportRef: RefObject<HTMLDivElement>;
  mediaDescription: (name: string) => string;
  openLightbox: (src: string, caption: string) => void;
  hasStream: boolean;
  streamUrl: string | null;
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

function LiveStreamSection({ streamUrl, selectedAgentId }: { streamUrl: string; selectedAgentId: string }): JSX.Element {
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
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-red-400">Live Stream</span>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={popOut}>
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

export function MediaSidebarContent({
  mediaFiles,
  selectedAgentId,
  selectedAgentName,
  animatingMediaKeys,
  seenMediaKeys,
  mediaViewportRef,
  mediaDescription,
  openLightbox,
  hasStream,
  streamUrl,
  onRequestClose,
  closeButtonIcon = "x",
  className
}: MediaSidebarContentProps): JSX.Element {
  return (
    <aside className={cn("flex h-full min-h-0 w-full flex-col border-l-2 border-border bg-card text-foreground", className)}>
      <div className="flex items-center px-3 py-2 pt-[env(safe-area-inset-top)]">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide">Media Stream</div>
          <div className="text-xs text-muted-foreground">
            Viewing: {selectedAgentName ?? "none"}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{mediaFiles.length} items</span>
          {onRequestClose ? (
            <Button size="icon" variant="ghost" onClick={onRequestClose} title="Close media sidebar">
              {closeButtonIcon === "chevron" ? <ChevronRight className="h-4 w-4" /> : <X className="h-4 w-4" />}
            </Button>
          ) : null}
        </div>
      </div>

      {hasStream && streamUrl && selectedAgentId ? (
        <LiveStreamSection streamUrl={streamUrl} selectedAgentId={selectedAgentId} />
      ) : null}

      <div ref={mediaViewportRef} className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {mediaFiles.length === 0 && !hasStream ? (
          <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
            {selectedAgentId ? "No media yet." : "Select an agent to view media."}
          </div>
        ) : mediaFiles.length === 0 ? null : (
          mediaFiles.map((file) => {
            const mediaKey = `${file.name}:${file.updatedAt}`;
            const cacheBustUrl = `${file.url}?t=${encodeURIComponent(file.updatedAt)}`;
            const animating = animatingMediaKeys.has(mediaKey);
            const unseen = !seenMediaKeys.has(mediaKey);

            return (
              <article
                key={mediaKey}
                data-media-key={mediaKey}
                className={cn(
                  "border-b-2 border-border px-3 py-3",
                  animating && "animate-media-in-slow"
                )}
              >
                <div className="mb-2 text-xs text-muted-foreground">{new Date(file.updatedAt).toLocaleString()}</div>
                <button
                  className={cn(
                    "block w-full overflow-hidden border-2 bg-black/60",
                    unseen ? "media-thumb-unseen" : "media-thumb-seen"
                  )}
                  onClick={() => openLightbox(cacheBustUrl, file.name)}
                >
                  <img src={cacheBustUrl} alt={file.name} className="max-h-[260px] w-full object-contain" />
                </button>
                <div className="mt-2 text-xs text-muted-foreground">
                  <div>{mediaDescription(file.name)}</div>
                  <div className="mt-1">{Math.max(1, Math.round(file.size / 1024))} KB</div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}

export function MediaSidebar({ mediaOpen, setMediaOpen, hasStream, ...props }: MediaSidebarProps): JSX.Element {
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
