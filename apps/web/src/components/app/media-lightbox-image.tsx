import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  useZoomableImage,
} from "@/hooks/use-zoomable-image";
import { cn } from "@/lib/utils";

export function ZoomableImage({
  src,
  alt,
  onPrevious,
  onNext,
}: {
  src: string;
  alt: string;
  onPrevious?: () => void;
  onNext?: () => void;
}): JSX.Element {
  const {
    viewportRef,
    imageRef,
    transform,
    reset,
    zoomAt,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    handleWheel,
    handleDoubleClick,
  } = useZoomableImage({ src, onPrevious, onNext });

  return (
    <div
      ref={viewportRef}
      data-testid="media-lightbox-image-viewport"
      className={cn(
        "absolute inset-0 flex select-none items-center justify-center overflow-hidden overscroll-none touch-none",
        transform.scale > 1
          ? "cursor-grab active:cursor-grabbing"
          : "cursor-zoom-in"
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        className="max-h-full max-w-full object-contain will-change-transform"
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] flex justify-center">
        <div
          className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/15 bg-black/65 p-1 text-white shadow-lg backdrop-blur"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <Button
            aria-label="Zoom out"
            data-testid="media-lightbox-zoom-out"
            disabled={transform.scale <= MIN_IMAGE_SCALE}
            size="icon"
            variant="ghost"
            className="h-10 w-10 rounded-full text-white hover:bg-white/15 hover:text-white"
            onClick={() => zoomAt(transform.scale / 1.5)}
          >
            <ZoomOut className="h-5 w-5" />
          </Button>
          <Button
            aria-label="Reset zoom"
            data-testid="media-lightbox-zoom-reset"
            size="sm"
            variant="ghost"
            className="h-10 min-w-16 rounded-full px-2 text-xs tabular-nums text-white hover:bg-white/15 hover:text-white"
            onClick={reset}
          >
            {Math.round(transform.scale * 100)}%
          </Button>
          <Button
            aria-label="Zoom in"
            data-testid="media-lightbox-zoom-in"
            disabled={transform.scale >= MAX_IMAGE_SCALE}
            size="icon"
            variant="ghost"
            className="h-10 w-10 rounded-full text-white hover:bg-white/15 hover:text-white"
            onClick={() => zoomAt(transform.scale * 1.5)}
          >
            <ZoomIn className="h-5 w-5" />
          </Button>
          <Button
            aria-label="Fit image to screen"
            size="icon"
            variant="ghost"
            className="h-10 w-10 rounded-full text-white hover:bg-white/15 hover:text-white"
            onClick={reset}
          >
            <Maximize2 className="h-5 w-5" />
          </Button>
        </div>
      </div>
      <span className="sr-only">
        Pinch or use the zoom controls to zoom. Drag to pan. Double tap to
        toggle zoom. Swipe left or right at one hundred percent zoom to change
        items.
      </span>
    </div>
  );
}
