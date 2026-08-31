import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { MediaActions } from "@/components/app/media-lightbox-actions";
import { ZoomableImage } from "@/components/app/media-lightbox-image";
import {
  MarkdownViewer,
  TextFileViewer,
} from "@/components/app/media-lightbox-text";
import {
  fileExtension,
  isTextFile,
  stripTimestamp,
} from "@/components/app/media-file-utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MediaLightboxItem = {
  src: string;
  caption: string;
  file: {
    name: string;
    size: number;
    updatedAt: string;
    source?: "screenshot" | "stream" | "simulator" | "text" | "user";
  };
};

type MediaLightboxProps = {
  item: MediaLightboxItem | null;
  currentIndex: number;
  totalItems: number;
  setLightboxIndex: (nextIndex: number | null) => void;
};

function isMarkdownFile(name: string): boolean {
  return fileExtension(name) === ".md";
}

function isHtmlFile(name: string): boolean {
  return fileExtension(name) === ".html";
}

export { MediaActions } from "@/components/app/media-lightbox-actions";

export function MediaLightbox({
  item,
  currentIndex,
  totalItems,
  setLightboxIndex,
}: MediaLightboxProps): JSX.Element | null {
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < totalItems - 1;
  // "name:updatedAt" of the version currently flashing "Updated", or null.
  const [announcedFor, setAnnouncedFor] = useState<string | null>(null);
  const [isTextContentStale, setIsTextContentStale] = useState(false);
  const lastSeenRef = useRef<{ name: string; updatedAt: string } | null>(null);
  const chipTimerRef = useRef<number | null>(null);

  const clearChipTimer = () => {
    if (chipTimerRef.current !== null) {
      window.clearTimeout(chipTimerRef.current);
      chipTimerRef.current = null;
    }
  };

  // A visible + screen-reader cue when the open file's content changes in
  // place (same identity, new updatedAt) — otherwise the same-scrollTop
  // content swap (or an HTML/PDF iframe resetting to the top; see the
  // sandbox comment below) reads as a glitch, not as "this was updated".
  // Driven off item.file.updatedAt rather than per-viewer content diffing
  // so it covers every lightbox type uniformly, markdown/text/HTML/PDF
  // alike, without reaching into the sandboxed iframe.
  //
  // Deps are the primitive name/updatedAt, not `item` itself: `item` is a
  // fresh object on every mediaFiles refetch (including ones that change
  // nothing), and depending on the object would re-run this effect — and
  // clear+never-rearm the chip timer via the cleanup below — on every one
  // of those, not just on a real update.
  useEffect(() => {
    if (!item) {
      lastSeenRef.current = null;
      setAnnouncedFor(null);
      setIsTextContentStale(false);
      clearChipTimer();
      return;
    }

    const prev = lastSeenRef.current;
    lastSeenRef.current = {
      name: item.file.name,
      updatedAt: item.file.updatedAt,
    };

    if (!prev || prev.name !== item.file.name) {
      // First open, or a real navigation to a different file: clear any
      // flash/stale state left over from whatever was open before — a
      // text viewer's stale flag doesn't self-clear on unmount, and a
      // lingering chip must not be read as describing the new file.
      setAnnouncedFor(null);
      setIsTextContentStale(false);
      clearChipTimer();
      return;
    }

    if (prev.updatedAt === item.file.updatedAt) return;

    clearChipTimer();
    setAnnouncedFor(`${item.file.name}:${item.file.updatedAt}`);
    chipTimerRef.current = window.setTimeout(() => {
      setAnnouncedFor(null);
      chipTimerRef.current = null;
    }, 2200);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrower than `item` deliberately, see the comment above this effect.
  }, [item?.file.name, item?.file.updatedAt]);

  useEffect(() => clearChipTimer, []);

  // Keep the page fixed behind the viewer. Image gestures are handled locally,
  // so the browser viewport never needs to zoom or scroll.
  useEffect(() => {
    if (!item) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [item]);

  useEffect(() => {
    if (!item) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setLightboxIndex(null);
        return;
      }

      if (event.key === "ArrowLeft" && canGoPrev) {
        event.preventDefault();
        event.stopPropagation();
        setLightboxIndex(currentIndex - 1);
        return;
      }

      if (event.key === "ArrowRight" && canGoNext) {
        event.preventDefault();
        event.stopPropagation();
        setLightboxIndex(currentIndex + 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGoNext, canGoPrev, currentIndex, item, setLightboxIndex]);

  if (!item) return null;

  const isText = item.file.source === "text" || isTextFile(item.file.name);
  const isMarkdown = isMarkdownFile(item.file.name);
  const isHtml = isHtmlFile(item.file.name);
  const isDocument = /\.pdf$/i.test(item.file.name);
  const isVideo = /\.mp4/i.test(item.src);
  const isImage = !isDocument && !isText && !isVideo;
  const displayName = stripTimestamp(item.file.name);
  // Gate directly on the current item's identity, not just on
  // announcedFor being non-null — belt-and-suspenders against the chip
  // ever describing a file other than the one on screen.
  const showUpdatedChip =
    !isTextContentStale &&
    announcedFor === `${item.file.name}:${item.file.updatedAt}`;
  const sizeLabel =
    item.file.size >= 1024 * 1024
      ? `${(item.file.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(item.file.size / 1024))} KB`;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[120] bg-black/90",
        isImage
          ? "overflow-hidden"
          : "grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] p-2 sm:p-6"
      )}
      data-testid="media-lightbox"
    >
      <div
        className={cn(
          "flex w-full items-center gap-3 overflow-hidden px-3 py-2 sm:px-4 sm:py-2.5",
          isImage
            ? "absolute inset-x-0 top-0 z-10 border-b border-white/10 bg-black/65 pt-[max(0.5rem,env(safe-area-inset-top))] text-white shadow-lg backdrop-blur"
            : "mx-auto max-w-4xl rounded-t-lg border border-b-0 border-border bg-surface"
        )}
      >
        <span
          className={cn(
            "min-w-0 shrink truncate text-xs font-medium sm:text-sm",
            isImage ? "text-white" : "text-foreground"
          )}
          title={isImage && item.caption ? displayName : undefined}
        >
          {isImage && item.caption ? item.caption : displayName}
        </span>
        {showUpdatedChip ? (
          <span
            className="flex-none rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
            aria-hidden="true"
          >
            Updated
          </span>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">
          {showUpdatedChip ? `${displayName} was just updated.` : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <MediaActions
            src={item.src}
            fileName={item.file.name}
            isText={isText}
            isMarkdown={isMarkdown}
            isHtml={isHtml}
          />
          <div className="mx-0.5 h-5 w-px bg-border" />
          <Button
            aria-label="Previous media item"
            data-testid="media-lightbox-prev"
            disabled={!canGoPrev}
            size="icon"
            variant="ghost"
            className={cn(
              "h-11 w-11 sm:h-9 sm:w-9",
              isImage && "text-white hover:bg-white/15 hover:text-white"
            )}
            onClick={() => setLightboxIndex(currentIndex - 1)}
          >
            <ChevronLeft className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
          <span
            className={cn(
              "hidden text-xs tabular-nums sm:inline",
              isImage ? "text-white/70" : "text-muted-foreground"
            )}
          >
            {totalItems > 0 ? `${currentIndex + 1}/${totalItems}` : ""}
          </span>
          <Button
            aria-label="Next media item"
            data-testid="media-lightbox-next"
            disabled={!canGoNext}
            size="icon"
            variant="ghost"
            className={cn(
              "h-11 w-11 sm:h-9 sm:w-9",
              isImage && "text-white hover:bg-white/15 hover:text-white"
            )}
            onClick={() => setLightboxIndex(currentIndex + 1)}
          >
            <ChevronRight className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <Button
            aria-label="Close"
            size="icon"
            variant="ghost"
            className={cn(
              "h-11 w-11 sm:h-9 sm:w-9",
              isImage && "text-white hover:bg-white/15 hover:text-white"
            )}
            onClick={() => setLightboxIndex(null)}
          >
            <X className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          isImage
            ? "absolute inset-0"
            : "mx-auto min-h-0 w-full max-w-4xl overflow-auto border-x border-border",
          isDocument || isHtml
            ? "bg-white"
            : isMarkdown
              ? "bg-background"
              : isText
                ? "bg-[hsl(var(--log-stream-bg))]"
                : "bg-black"
        )}
      >
        {isDocument ? (
          <iframe
            src={item.src}
            title={displayName}
            className="h-full w-full"
          />
        ) : isHtml ? (
          <iframe
            src={item.src}
            title={displayName}
            // No allow-same-origin: the document gets an opaque origin and
            // cannot reach the Dispatch API or storage.
            sandbox="allow-scripts allow-popups"
            className="h-full min-h-[60vh] w-full"
            data-testid="media-lightbox-html"
          />
        ) : isText ? (
          isMarkdown ? (
            <MarkdownViewer
              src={item.src}
              fileName={item.file.name}
              onStaleChange={setIsTextContentStale}
            />
          ) : (
            <TextFileViewer
              src={item.src}
              fileName={item.file.name}
              onStaleChange={setIsTextContentStale}
            />
          )
        ) : isVideo ? (
          <video
            src={item.src}
            controls
            playsInline
            className="max-h-[calc(100vh-12rem)] w-full object-contain"
          />
        ) : (
          <ZoomableImage
            src={item.src}
            alt={item.caption || displayName}
            onPrevious={
              canGoPrev ? () => setLightboxIndex(currentIndex - 1) : undefined
            }
            onNext={
              canGoNext ? () => setLightboxIndex(currentIndex + 1) : undefined
            }
          />
        )}
      </div>
      {!isImage && (
        <div className="mx-auto flex w-full max-w-4xl items-center gap-2 rounded-b-lg border border-t-0 border-border bg-surface px-2 py-1.5 text-xs text-muted-foreground sm:gap-3 sm:px-4 sm:py-2">
          {item.caption ? (
            <span className="min-w-0 truncate">{item.caption}</span>
          ) : null}
          {item.file.source ? (
            <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {item.file.source === "user" ? "your upload" : item.file.source}
            </span>
          ) : null}
          <span className="ml-auto flex-none">{sizeLabel}</span>
          <span className="hidden flex-none sm:inline">
            {new Date(item.file.updatedAt).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
