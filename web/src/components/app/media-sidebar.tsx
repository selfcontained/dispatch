import { type RefObject } from "react";
import { ChevronRight } from "lucide-react";

import { type MediaFile } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MediaSidebarProps = {
  mediaOpen: boolean;
  mediaFiles: MediaFile[];
  selectedAgentId: string | null;
  animatingMediaKeys: Set<string>;
  mediaViewportRef: RefObject<HTMLDivElement>;
  setMediaOpen: (open: boolean) => void;
  mediaDescription: (name: string) => string;
  openLightbox: (src: string, caption: string) => void;
};

export function MediaSidebar({
  mediaOpen,
  mediaFiles,
  selectedAgentId,
  animatingMediaKeys,
  mediaViewportRef,
  setMediaOpen,
  mediaDescription,
  openLightbox
}: MediaSidebarProps): JSX.Element {
  return (
    <div
      className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: mediaOpen ? 360 : 0 }}
    >
      <aside className="flex h-full min-h-0 w-[360px] flex-col bg-card">
        <div className="flex h-14 items-center px-3">
          <div className="text-sm font-semibold uppercase tracking-wide">Media Stream</div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{mediaFiles.length} items</span>
            <Button size="icon" variant="ghost" onClick={() => setMediaOpen(false)} title="Close media sidebar">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div ref={mediaViewportRef} className="min-h-0 flex-1 overflow-y-auto">
          {mediaFiles.length === 0 ? (
            <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
              {selectedAgentId ? "No media yet." : "Select an agent to view media."}
            </div>
          ) : (
            mediaFiles.map((file) => {
              const mediaKey = `${file.name}:${file.updatedAt}`;
              const cacheBustUrl = `${file.url}?t=${encodeURIComponent(file.updatedAt)}`;

              return (
                <article
                  key={mediaKey}
                  data-media-key={mediaKey}
                  className={cn(
                    "border-b-2 border-border px-3 py-3",
                    animatingMediaKeys.has(mediaKey) && "animate-media-in"
                  )}
                >
                  <div className="mb-2 text-xs text-muted-foreground">{new Date(file.updatedAt).toLocaleString()}</div>
                  <button
                    className="block w-full overflow-hidden border-2 border-border bg-black/60"
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
    </div>
  );
}
