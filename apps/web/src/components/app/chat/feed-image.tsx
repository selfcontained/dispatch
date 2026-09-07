import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * An image in the chat feed, in a box that is the right size before the bytes
 * arrive.
 *
 * The feed loads images lazily, so a box that sized itself to the file would be
 * 0px until the image landed and then shove everything below it down — which is
 * what pushes a reader off the message they were on. Every value here resolves
 * at layout time from numbers the server already stored, so the box the reader
 * sees while an image is still in flight is the box it ends up occupying.
 *
 * Both branches live here so a caller supplies one max height and nothing has
 * to be kept in step: the reserved box and the fallback are two halves of one
 * decision, and they used to be a pixel literal in one file and a Tailwind
 * class in another.
 */

/**
 * Floor for a reserved box, on both axes.
 *
 * A ratio box has a cap but needs a floor too. A 2000x20 crop reserves a box
 * three pixels tall; a 16x16 favicon reserves sixteen. Both are legible as
 * neither an image nor a click target, and both are a regression against the
 * fixed-height box this replaced. 44px is the conventional minimum touch
 * target, and `object-scale-down` keeps the picture itself undistorted and
 * centred inside a floored box rather than stretching it.
 */
const MIN_BOX = "2.75rem";

/**
 * The box an image gets to occupy.
 *
 * With `width`/`height` known:
 *
 *  - `width` is a **definite pixel value**, not a percentage. Inside the
 *    shrink-to-fit `<button>` these images sit in, `width: 100%` has no basis
 *    until the image has intrinsic dimensions, so the button would size itself
 *    to the alt text and everything would jump on decode. The width cannot be
 *    left to resolve later.
 *  - `maxWidth: 100%` lets a narrow column shrink the box without ever being
 *    what establishes its size.
 *  - `aspectRatio` makes height follow width, which is what removes the dead
 *    space a fixed-height letterbox left around anything short or narrow.
 *
 * The width is capped at whichever comes first: the image's own natural width
 * (never upscale a thumbnail into a blurry banner) or the width at which the
 * ratio would push the height past `maxHeightPx` (never let one tall screenshot
 * take over the feed). Capping *width* rather than height is what keeps the
 * frame flush around a tall image — a `max-height` would clamp the frame and
 * leave the image floating inside it again.
 *
 * `containerMax` is any CSS length the caller's own layout imposes, folded in
 * here because an inline width would otherwise ignore a class that sets it.
 * Both operands are absolute, so the `min()` still resolves without knowing
 * anything about the parent.
 *
 * Without them, the box falls back to the fixed height that shipped before any
 * of this: it letterboxes, but it does not move.
 */
export function feedImageBoxStyle(
  width: number | undefined,
  height: number | undefined,
  maxHeightPx: number,
  containerMax?: string
): CSSProperties {
  if (!width || !height) {
    return {
      width: "100%",
      height: `${maxHeightPx}px`,
      ...(containerMax ? { maxWidth: containerMax } : {}),
    };
  }
  // Deliberately unrounded: an image tall enough that its width at the maximum
  // height lands under half a pixel would round to a 0px box and vanish.
  const widthAtMaxHeight = maxHeightPx * (width / height);
  const cap = `${Math.min(width, widthAtMaxHeight)}px`;
  return {
    width: containerMax ? `min(${containerMax}, ${cap})` : cap,
    maxWidth: "100%",
    minWidth: MIN_BOX,
    minHeight: MIN_BOX,
    aspectRatio: `${width} / ${height}`,
  };
}

export function FeedImage({
  src,
  alt,
  width,
  height,
  maxHeightPx,
  containerMax,
  className,
}: {
  src: string;
  alt: string;
  /** Natural size from the media row, absent when it could not be read. */
  width?: number;
  height?: number;
  /** Tallest the image is allowed to be, and the fallback's fixed height. */
  maxHeightPx: number;
  /** A CSS length the caller's layout imposes on the box, e.g. `"20rem"`. */
  containerMax?: string;
  className?: string;
}): JSX.Element {
  const sized = Boolean(width && height);
  return (
    <img
      src={src}
      alt={alt}
      className={cn(
        // overflow-hidden matters only when the file is missing: a broken <img>
        // lays out its alt text as content, and an aspect-ratio height is a
        // preferred size that content can push past — which would move the
        // feed. Clipping keeps the box the size that was reserved for it.
        "overflow-hidden object-scale-down",
        // The tint fills a reserved box while its image is in flight, so the
        // space reads as a picture arriving. On the fallback it would instead
        // paint the dead space around a letterboxed image as a grey slab,
        // which reads as a wrongly-sized frame rather than a plain one — and
        // with the backfill gone, the fallback sits next to ratio-boxed
        // neighbours forever, so the difference wants to look like a size, not
        // a fault.
        sized && "bg-muted/30",
        className
      )}
      style={feedImageBoxStyle(width, height, maxHeightPx, containerMax)}
      loading="lazy"
    />
  );
}
