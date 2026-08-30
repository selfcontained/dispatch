import { useCallback, useRef, useState } from "react";

import { DIFF_IMAGE_MAX_BYTES, type DiffImageInfo } from "@dispatch/shared";
import { useAtom, useAtomValue } from "jotai";

import { cn } from "@/lib/utils";
import {
  diffImageCompareModeAtom,
  diffIncludeUncommittedAtom,
  type DiffImageCompareMode,
} from "@/lib/store";
import type { DiffFileStatus } from "@/hooks/use-agent-diff";
import { Slider } from "@/components/ui/slider";

type Side = "old" | "new";

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function imageUrl(
  agentId: string,
  filePath: string,
  side: Side,
  includeUncommitted: boolean
): string {
  return `/api/v1/agents/${agentId}/diff/image?path=${encodeURIComponent(
    filePath
  )}&side=${side}&includeUncommitted=${includeUncommitted}`;
}

type LoadedImage = { width: number; height: number };

/** One side of the comparison: the picture plus its size/dimension caption. */
function ImagePanel({
  src,
  label,
  tone,
  bytes,
  className,
  imgClassName,
  onLoad,
  dimensions,
}: {
  src: string | null;
  label: string;
  tone: "old" | "new";
  bytes: number | null;
  className?: string;
  imgClassName?: string;
  onLoad?: (dim: LoadedImage) => void;
  dimensions?: LoadedImage | null;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const tooLarge = bytes !== null && bytes > DIFF_IMAGE_MAX_BYTES;

  return (
    <div className={cn("flex min-w-0 flex-col items-center gap-2", className)}>
      <div className="flex flex-wrap items-center justify-center gap-x-2 text-[10px] uppercase tracking-wide">
        <span
          className={cn(
            "font-medium",
            tone === "old" ? "text-status-blocked" : "text-status-working"
          )}
        >
          {label}
        </span>
        <span className="font-mono text-muted-foreground normal-case tracking-normal">
          {dimensions ? `${dimensions.width}×${dimensions.height}` : null}
          {dimensions && bytes !== null ? " · " : null}
          {bytes !== null ? formatBytes(bytes) : null}
        </span>
      </div>
      {src === null || tooLarge || failed ? (
        <div className="flex min-h-[4rem] w-full items-center justify-center rounded border border-dashed border-border/60 px-3 py-6 text-[11px] text-muted-foreground">
          {tooLarge
            ? `Too large to preview (${formatBytes(bytes!)})`
            : src === null
              ? "Not present"
              : "Preview unavailable"}
        </div>
      ) : (
        <img
          src={src}
          alt={label}
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={(e) =>
            onLoad?.({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
          className={cn(
            "diff-image-checkerboard max-h-[26rem] max-w-full rounded border border-border/60 object-contain",
            imgClassName
          )}
        />
      )}
    </div>
  );
}

const MODES: { value: DiffImageCompareMode; label: string }[] = [
  { value: "two-up", label: "2-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion" },
];

/**
 * Image rendering for the Changes pane.
 *
 * Added and deleted files show the one side that exists. A modified (or
 * renamed-and-modified) file gets the three comparisons GitHub popularised —
 * side-by-side, a swipe divider, and an onion-skin fade — because which one
 * reads best depends entirely on the change: a recolour is obvious 2-up, a
 * one-pixel nudge only shows up under swipe or onion.
 */
export function DiffImageView({
  agentId,
  filePath,
  oldPath,
  status,
  image,
}: {
  agentId: string | null;
  filePath: string;
  oldPath?: string;
  status: DiffFileStatus;
  image: DiffImageInfo;
}): JSX.Element {
  const includeUncommitted = useAtomValue(diffIncludeUncommittedAtom);
  const [mode, setMode] = useAtom(diffImageCompareModeAtom);
  const [oldDim, setOldDim] = useState<LoadedImage | null>(null);
  const [newDim, setNewDim] = useState<LoadedImage | null>(null);
  const [position, setPosition] = useState(50);

  const hasOld = image.oldSize !== null;
  const hasNew = image.newSize !== null;

  const oldSrc =
    agentId && hasOld
      ? imageUrl(agentId, oldPath ?? filePath, "old", includeUncommitted)
      : null;
  const newSrc =
    agentId && hasNew
      ? imageUrl(agentId, filePath, "new", includeUncommitted)
      : null;

  const oldLabel = status === "deleted" ? "Deleted" : "Before";
  const newLabel = status === "added" ? "Added" : "After";

  if (!hasOld || !hasNew) {
    return (
      <div className="flex justify-center bg-muted/10 px-4 py-4">
        <ImagePanel
          src={hasNew ? newSrc : oldSrc}
          label={hasNew ? newLabel : oldLabel}
          tone={hasNew ? "new" : "old"}
          bytes={hasNew ? image.newSize : image.oldSize}
          dimensions={hasNew ? newDim : oldDim}
          onLoad={hasNew ? setNewDim : setOldDim}
          className="max-w-full"
        />
      </div>
    );
  }

  return (
    <div className="bg-muted/10 px-4 py-4">
      <div className="mb-3 flex justify-center">
        <div
          role="group"
          aria-label="Image comparison mode"
          className="flex rounded-md border border-border/60 bg-muted/30 p-0.5"
        >
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={mode === m.value}
              data-testid={`diff-image-mode:${m.value}`}
              className={cn(
                "whitespace-nowrap rounded-[3px] px-2.5 py-1 text-[11px] font-medium transition-colors",
                mode === m.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "two-up" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ImagePanel
            src={oldSrc}
            label={oldLabel}
            tone="old"
            bytes={image.oldSize}
            dimensions={oldDim}
            onLoad={setOldDim}
          />
          <ImagePanel
            src={newSrc}
            label={newLabel}
            tone="new"
            bytes={image.newSize}
            dimensions={newDim}
            onLoad={setNewDim}
          />
        </div>
      ) : (
        <OverlayCompare
          mode={mode}
          oldSrc={oldSrc!}
          newSrc={newSrc!}
          position={position}
          onPosition={setPosition}
          onOldLoad={setOldDim}
          onNewLoad={setNewDim}
        />
      )}

      {/* 2-up already captions each side; the overlay modes stack the two
          images, so this is the only place their sizes can be read. */}
      {mode === "two-up" ? null : (
        <div className="mt-3 flex items-center justify-center gap-3 text-[10px] font-mono text-muted-foreground">
          <span className="text-status-blocked">
            {oldDim ? `${oldDim.width}×${oldDim.height}` : "—"}
            {image.oldSize !== null ? ` · ${formatBytes(image.oldSize)}` : ""}
          </span>
          <span>→</span>
          <span className="text-status-working">
            {newDim ? `${newDim.width}×${newDim.height}` : "—"}
            {image.newSize !== null ? ` · ${formatBytes(image.newSize)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Swipe and onion share a stacked layout: both images sit in the same box so
 * corresponding pixels line up, and the slider changes only how much of the
 * new one is revealed (a clip for swipe, an opacity for onion).
 */
function OverlayCompare({
  mode,
  oldSrc,
  newSrc,
  position,
  onPosition,
  onOldLoad,
  onNewLoad,
}: {
  mode: Exclude<DiffImageCompareMode, "two-up">;
  oldSrc: string;
  newSrc: string;
  position: number;
  onPosition: (value: number) => void;
  onOldLoad: (dim: LoadedImage) => void;
  onNewLoad: (dim: LoadedImage) => void;
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);

  const handleLoad = useCallback(
    (cb: (dim: LoadedImage) => void) =>
      (e: React.SyntheticEvent<HTMLImageElement>) => {
        cb({
          width: e.currentTarget.naturalWidth,
          height: e.currentTarget.naturalHeight,
        });
      },
    []
  );

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        ref={boxRef}
        className="relative inline-block max-w-full"
        data-testid="diff-image-overlay"
      >
        <img
          src={oldSrc}
          alt="Before"
          onLoad={handleLoad(onOldLoad)}
          className="diff-image-checkerboard block max-h-[26rem] max-w-full rounded border border-border/60 object-contain"
        />
        <img
          src={newSrc}
          alt="After"
          onLoad={handleLoad(onNewLoad)}
          className="diff-image-checkerboard absolute inset-0 h-full w-full rounded border border-border/60 object-contain"
          style={
            mode === "swipe"
              ? { clipPath: `inset(0 0 0 ${position}%)` }
              : { opacity: position / 100 }
          }
        />
        {mode === "swipe" ? (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-primary"
            style={{ left: `${position}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <Slider
        value={[position]}
        min={0}
        max={100}
        step={1}
        onValueChange={([v]) => onPosition(v ?? 50)}
        aria-label={mode === "swipe" ? "Swipe position" : "Onion skin opacity"}
        className="w-56"
      />
    </div>
  );
}
