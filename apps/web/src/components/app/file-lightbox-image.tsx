import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
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
      data-testid="file-lightbox-image-viewport"
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
          className="surface-overlay pointer-events-auto flex items-center gap-1 rounded-full p-1 text-overlay-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <IconButton
            label="Zoom out"
            data-testid="file-lightbox-zoom-out"
            disabled={transform.scale <= MIN_IMAGE_SCALE}
            className="rounded-full text-overlay-foreground hover:bg-fill-hover hover:text-overlay-foreground"
            onClick={() => zoomAt(transform.scale / 1.5)}
          >
            <ZoomOut />
          </IconButton>
          <Button
            aria-label="Reset zoom"
            data-testid="file-lightbox-zoom-reset"
            size="sm"
            variant="ghost"
            className="min-w-16 rounded-full text-body-sm tabular-nums text-overlay-foreground hover:bg-fill-hover hover:text-overlay-foreground"
            onClick={reset}
          >
            {Math.round(transform.scale * 100)}%
          </Button>
          <IconButton
            label="Zoom in"
            data-testid="file-lightbox-zoom-in"
            disabled={transform.scale >= MAX_IMAGE_SCALE}
            className="rounded-full text-overlay-foreground hover:bg-fill-hover hover:text-overlay-foreground"
            onClick={() => zoomAt(transform.scale * 1.5)}
          >
            <ZoomIn />
          </IconButton>
          <IconButton
            label="Fit image to screen"
            className="rounded-full text-overlay-foreground hover:bg-fill-hover hover:text-overlay-foreground"
            onClick={reset}
          >
            <Maximize2 />
          </IconButton>
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
