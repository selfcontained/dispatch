import { useCallback, useState } from "react";

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

/**
 * Height held for an image that has not loaded yet. Nothing in the diff
 * payload carries pixel dimensions, so the reserve is a flat guess — its job
 * is only to stop a section collapsing to zero and then jumping the scroll
 * position of whatever the reviewer is reading below it.
 */
const PREVIEW_RESERVE = "min-h-[8rem]";

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

/** Aspect ratios within half a percent — tolerance for rounding, not resizes. */
function aspectRatiosMatch(a: LoadedImage, b: LoadedImage): boolean {
  if (a.height === 0 || b.height === 0) return false;
  const ratioA = a.width / a.height;
  const ratioB = b.width / b.height;
  return Math.abs(ratioA - ratioB) / Math.max(ratioA, ratioB) < 0.005;
}

function readNaturalSize(
  e: React.SyntheticEvent<HTMLImageElement>
): LoadedImage {
  return {
    width: e.currentTarget.naturalWidth,
    height: e.currentTarget.naturalHeight,
  };
}

type SideState = {
  src: string | null;
  bytes: number | null;
  dimensions: LoadedImage | null;
  failed: boolean;
  onLoad: (dim: LoadedImage) => void;
  onError: () => void;
};

/** Why a side cannot be shown, or null when it can. */
function blockedReason(side: SideState): string | null {
  if (side.bytes !== null && side.bytes > DIFF_IMAGE_MAX_BYTES) {
    return `Too large to preview (${formatBytes(side.bytes)})`;
  }
  if (side.src === null) return "Not present";
  if (side.failed) return "Preview unavailable";
  return null;
}

/** One side of the comparison: the picture plus its size/dimension caption. */
function ImagePanel({
  side,
  label,
  tone,
  className,
}: {
  side: SideState;
  label: string;
  tone: "old" | "new";
  className?: string;
}): JSX.Element {
  const blocked = blockedReason(side);

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
          {side.dimensions
            ? `${side.dimensions.width}×${side.dimensions.height}`
            : null}
          {side.dimensions && side.bytes !== null ? " · " : null}
          {side.bytes !== null ? formatBytes(side.bytes) : null}
        </span>
      </div>
      {blocked !== null ? (
        <div
          className={cn(
            "flex w-full items-center justify-center rounded border border-dashed border-border/60 px-3 py-6 text-[11px] text-muted-foreground",
            PREVIEW_RESERVE
          )}
        >
          {blocked}
        </div>
      ) : (
        <div
          className={cn(
            "flex w-full items-center justify-center",
            side.dimensions ? null : PREVIEW_RESERVE
          )}
        >
          <img
            src={side.src!}
            alt={label}
            loading="lazy"
            onError={side.onError}
            onLoad={(e) => side.onLoad(readNaturalSize(e))}
            className="diff-image-checkerboard max-h-[26rem] max-w-full rounded border border-border/60 object-contain"
          />
        </div>
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
  const [oldFailed, setOldFailed] = useState(false);
  const [newFailed, setNewFailed] = useState(false);
  const [position, setPosition] = useState(50);

  const hasOld = image.oldSize !== null;
  const hasNew = image.newSize !== null;

  const oldSide: SideState = {
    src:
      agentId && hasOld
        ? imageUrl(agentId, oldPath ?? filePath, "old", includeUncommitted)
        : null,
    bytes: image.oldSize,
    dimensions: oldDim,
    failed: oldFailed,
    onLoad: setOldDim,
    onError: useCallback(() => setOldFailed(true), []),
  };
  const newSide: SideState = {
    src:
      agentId && hasNew
        ? imageUrl(agentId, filePath, "new", includeUncommitted)
        : null,
    bytes: image.newSize,
    dimensions: newDim,
    failed: newFailed,
    onLoad: setNewDim,
    onError: useCallback(() => setNewFailed(true), []),
  };

  const oldLabel = status === "deleted" ? "Deleted" : "Before";
  const newLabel = status === "added" ? "Added" : "After";

  if (!hasOld || !hasNew) {
    const only = hasNew ? newSide : oldSide;
    return (
      <div className="flex justify-center bg-muted/10 px-4 py-4">
        <ImagePanel
          side={only}
          label={hasNew ? newLabel : oldLabel}
          tone={hasNew ? "new" : "old"}
          className="max-w-full"
        />
      </div>
    );
  }

  // Stacking two images only tells the truth when they occupy the same
  // rectangle, so the overlay modes stay locked until both sides have loaded
  // and reported the same aspect ratio. Everything else — a side over the size
  // cap, a side that failed to load, a resized image — falls back to 2-up,
  // where each side is captioned with what actually happened to it.
  const unavailableReason =
    blockedReason(oldSide) !== null || blockedReason(newSide) !== null
      ? "One side cannot be previewed"
      : !oldDim || !newDim
        ? "Loading…"
        : !aspectRatiosMatch(oldDim, newDim)
          ? "Image was resized — overlays would not line up"
          : null;
  const effectiveMode = unavailableReason === null ? mode : "two-up";

  return (
    <div className="bg-muted/10 px-4 py-4">
      <div className="mb-3 flex flex-col items-center gap-1">
        <div
          role="group"
          aria-label="Image comparison mode"
          className="flex rounded-md border border-border/60 bg-muted/30 p-0.5"
        >
          {MODES.map((m) => {
            const disabled = m.value !== "two-up" && unavailableReason !== null;
            return (
              <button
                key={m.value}
                type="button"
                disabled={disabled}
                aria-pressed={effectiveMode === m.value}
                aria-describedby={
                  disabled ? `diff-image-modes-hint-${filePath}` : undefined
                }
                data-testid={`diff-image-mode:${m.value}`}
                className={cn(
                  "whitespace-nowrap rounded-[3px] px-2.5 py-1 text-[11px] font-medium transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  effectiveMode === m.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setMode(m.value)}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        {unavailableReason !== null && unavailableReason !== "Loading…" ? (
          <p
            id={`diff-image-modes-hint-${filePath}`}
            className="text-[10px] text-muted-foreground"
          >
            {unavailableReason}
          </p>
        ) : null}
      </div>

      {effectiveMode === "two-up" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ImagePanel side={oldSide} label={oldLabel} tone="old" />
          <ImagePanel side={newSide} label={newLabel} tone="new" />
        </div>
      ) : (
        <>
          <OverlayCompare
            mode={effectiveMode}
            oldSide={oldSide}
            newSide={newSide}
            position={position}
            onPosition={setPosition}
          />
          {/* 2-up captions each side itself; stacked, this is the only place
              the before/after numbers can be read. */}
          <div className="mt-3 flex items-center justify-center gap-3 font-mono text-[10px] text-muted-foreground">
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
        </>
      )}
    </div>
  );
}

/**
 * Swipe and onion share a stacked layout: both images sit in the same box so
 * corresponding pixels line up, and the slider changes only how much of the
 * new one is revealed (a clip for swipe, an opacity for onion). The caller
 * only mounts this once both sides are known to share an aspect ratio, which
 * is what makes that correspondence real.
 */
function OverlayCompare({
  mode,
  oldSide,
  newSide,
  position,
  onPosition,
}: {
  mode: Exclude<DiffImageCompareMode, "two-up">;
  oldSide: SideState;
  newSide: SideState;
  position: number;
  onPosition: (value: number) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative inline-block max-w-full"
        data-testid="diff-image-overlay"
      >
        <img
          src={oldSide.src!}
          alt="Before"
          onError={oldSide.onError}
          onLoad={(e) => oldSide.onLoad(readNaturalSize(e))}
          className="diff-image-checkerboard block max-h-[26rem] max-w-full rounded border border-border/60 object-contain"
        />
        <img
          src={newSide.src!}
          alt="After"
          onError={newSide.onError}
          onLoad={(e) => newSide.onLoad(readNaturalSize(e))}
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
