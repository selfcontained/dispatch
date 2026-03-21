import { type TouchEvent, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

type MediaLightboxItem = {
  src: string;
  caption: string;
  file: {
    name: string;
    source?: "screenshot" | "stream" | "simulator";
  };
};

type MediaLightboxProps = {
  item: MediaLightboxItem | null;
  currentIndex: number;
  totalItems: number;
  setLightboxIndex: (nextIndex: number | null) => void;
};

const SWIPE_THRESHOLD_PX = 48;

export function MediaLightbox({
  item,
  currentIndex,
  totalItems,
  setLightboxIndex
}: MediaLightboxProps): JSX.Element | null {
  const touchStartXRef = useRef<number | null>(null);

  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < totalItems - 1;

  useEffect(() => {
    if (!item) {
      return;
    }

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
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canGoNext, canGoPrev, currentIndex, item, setLightboxIndex]);

  if (!item) {
    return null;
  }

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = event.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (touchStartXRef.current === null) {
      return;
    }

    const endX = event.changedTouches[0]?.clientX ?? touchStartXRef.current;
    const deltaX = endX - touchStartXRef.current;
    touchStartXRef.current = null;

    if (deltaX <= -SWIPE_THRESHOLD_PX && canGoNext) {
      setLightboxIndex(currentIndex + 1);
      return;
    }

    if (deltaX >= SWIPE_THRESHOLD_PX && canGoPrev) {
      setLightboxIndex(currentIndex - 1);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] grid grid-rows-[auto_1fr_auto] gap-3 bg-black/90 p-4 sm:p-6"
      data-testid="media-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setLightboxIndex(null);
        }
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
          {totalItems > 0 ? `${currentIndex + 1} / ${totalItems}` : ""}
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Previous media item"
            data-testid="media-lightbox-prev"
            disabled={!canGoPrev}
            size="icon"
            variant="ghost"
            onClick={() => setLightboxIndex(currentIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button onClick={() => setLightboxIndex(null)}>Close</Button>
          <Button
            aria-label="Next media item"
            data-testid="media-lightbox-next"
            disabled={!canGoNext}
            size="icon"
            variant="ghost"
            onClick={() => setLightboxIndex(currentIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        className="relative grid min-h-0 grid-cols-[minmax(0,1fr)] place-items-center overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <button
          aria-label="Previous media item"
          className="absolute left-0 top-0 z-10 hidden h-full w-1/5 min-w-12 items-center justify-start bg-gradient-to-r from-black/35 to-transparent pl-2 text-white/70 transition hover:text-white disabled:pointer-events-none disabled:opacity-0 sm:flex"
          disabled={!canGoPrev}
          onClick={() => setLightboxIndex(currentIndex - 1)}
          type="button"
        >
          <ChevronLeft className="h-8 w-8" />
        </button>

        {/\.mp4/i.test(item.src) ? (
          <video
            src={item.src}
            controls
            playsInline
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain sm:max-h-[calc(100vh-9rem)] sm:max-w-[calc(100vw-6rem)]"
          />
        ) : (
          <img
            src={item.src}
            alt={item.caption}
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain sm:max-h-[calc(100vh-9rem)] sm:max-w-[calc(100vw-6rem)]"
          />
        )}

        <button
          aria-label="Next media item"
          className="absolute right-0 top-0 z-10 hidden h-full w-1/5 min-w-12 items-center justify-end bg-gradient-to-l from-black/35 to-transparent pr-2 text-white/70 transition hover:text-white disabled:pointer-events-none disabled:opacity-0 sm:flex"
          disabled={!canGoNext}
          onClick={() => setLightboxIndex(currentIndex + 1)}
          type="button"
        >
          <ChevronRight className="h-8 w-8" />
        </button>
      </div>
      <div className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <span>{item.caption}</span>
        {item.file.source ? <span className="text-xs uppercase tracking-wide">{item.file.source}</span> : null}
      </div>
    </div>
  );
}
