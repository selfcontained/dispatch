import type { ElementContext } from "../types";

/**
 * Longest edge (in device pixels) of the cropped screenshot. Larger crops are
 * downscaled to keep the delivered PNG — and the base64 payload it travels in —
 * comfortably under the submission body limit.
 */
export const MAX_SCREENSHOT_DIMENSION = 1600;

export interface CapturedScreenshot {
  /** `data:image/png;base64,…` form, suitable for an <img> preview. */
  dataUrl: string;
  /** Bare base64 (no data-URL prefix), the form sent to Dispatch. */
  base64: string;
}

export type CaptureResult =
  | { ok: true; screenshot: CapturedScreenshot }
  | { ok: false; reason: string };

export interface CropRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

/**
 * Map an element's CSS-pixel viewport rect onto the captured PNG (which is sized
 * in device pixels) and clamp it to the image bounds. Returns null when the
 * element has no visible area inside the capture — e.g. it was scrolled out of
 * view — so the caller can skip attaching an empty image.
 */
export function computeCropRegion(
  rect: ElementContext["rect"],
  devicePixelRatio: number,
  imageWidth: number,
  imageHeight: number,
  maxDimension: number = MAX_SCREENSHOT_DIMENSION
): CropRegion | null {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const left = Math.max(0, Math.round(rect.x * dpr));
  const top = Math.max(0, Math.round(rect.y * dpr));
  const right = Math.min(imageWidth, Math.round((rect.x + rect.width) * dpr));
  const bottom = Math.min(
    imageHeight,
    Math.round((rect.y + rect.height) * dpr)
  );

  const sw = right - left;
  const sh = bottom - top;
  if (sw <= 0 || sh <= 0) return null;

  const scale = Math.min(1, maxDimension / Math.max(sw, sh));
  return {
    sx: left,
    sy: top,
    sw,
    sh,
    dw: Math.max(1, Math.round(sw * scale)),
    dh: Math.max(1, Math.round(sh * scale)),
  };
}

/** Strip the `data:...;base64,` prefix, returning the bare base64 payload. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "";
}

function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

/**
 * Capture the visible tab and crop it to the selected element. Best-effort: any
 * failure (denied capture, tainted canvas, off-screen element) is reported as a
 * reason string rather than thrown, so feedback submission is never blocked on
 * the image while the UI can still explain why one is missing.
 */
export async function captureElementScreenshot(
  windowId: number,
  rect: ElementContext["rect"],
  devicePixelRatio: number
): Promise<CaptureResult> {
  let captured: string;
  try {
    captured = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `captureVisibleTab error: ${message}` };
  }
  const lastError = chrome.runtime.lastError?.message;
  if (lastError)
    return { ok: false, reason: `captureVisibleTab: ${lastError}` };
  if (!captured)
    return { ok: false, reason: "captureVisibleTab returned empty" };

  const image = await loadImage(captured);
  if (!image) return { ok: false, reason: "captured image failed to decode" };

  const region = computeCropRegion(
    rect,
    devicePixelRatio,
    image.naturalWidth,
    image.naturalHeight
  );
  if (!region) {
    return {
      ok: false,
      reason:
        `element outside captured viewport ` +
        `(rect ${Math.round(rect.width)}×${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)}; ` +
        `image ${image.naturalWidth}×${image.naturalHeight}; dpr ${devicePixelRatio})`,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = region.dw;
  canvas.height = region.dh;
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, reason: "canvas 2d context unavailable" };

  try {
    context.drawImage(
      image,
      region.sx,
      region.sy,
      region.sw,
      region.sh,
      0,
      0,
      region.dw,
      region.dh
    );
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = stripDataUrlPrefix(dataUrl);
    if (!base64) return { ok: false, reason: "empty PNG after crop" };
    return { ok: true, screenshot: { dataUrl, base64 } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `crop failed: ${message}` };
  }
}
