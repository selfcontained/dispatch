import { seatClasses } from "@/lib/agent-seat";

/** One numbered callout on an image, in normalized, oriented image coordinates. */
export type ImageCalloutRegion = {
  id: string;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
};

export function isImageCalloutRegion(
  value: unknown
): value is ImageCalloutRegion {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    Number.isInteger(c.number) &&
    (c.number as number) > 0 &&
    typeof c.note === "string" &&
    [c.x, c.y, c.width, c.height].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1
    )
  );
}

/** The numbered note list a feedback message carries for text-only readers. */
export function imageFeedbackNotes(
  items: readonly ImageCalloutRegion[]
): string {
  return items
    .map((c) => {
      const marker = `${c.number}. `;
      return (
        marker + c.note.trim().replace(/\n/g, `\n${" ".repeat(marker.length)}`)
      );
    })
    .join("\n\n");
}

/** The longest side an annotated copy is exported at. */
const ANNOTATED_MAX_SIDE = 2560;

/** Resolve SVGs without intrinsic dimensions without inserting their markup into the DOM.
 * Explicit element dimensions also give WebKit a viewport for canvas drawing.
 */
export async function imageRasterSize(image: HTMLImageElement) {
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  let width = 300,
    height = 150;
  const response = await fetch(image.src);
  if (!response.ok) throw new Error("Unable to load image dimensions.");
  const root = new DOMParser().parseFromString(
    await response.text(),
    "image/svg+xml"
  ).documentElement;
  if (root.localName !== "svg")
    throw new Error("Unable to read image dimensions.");
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const dimension = (name: string) => {
    const value = root.getAttribute(name)?.trim() ?? "";
    return /^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value)
      ? Number.isFinite(parseFloat(value))
        ? parseFloat(value)
        : 0
      : 0;
  };
  const w = dimension("width"),
    h = dimension("height");
  const validViewBox =
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0
      ? viewBox
      : undefined;
  const ratio = validViewBox ? validViewBox[2] / validViewBox[3] : 2;
  width = w || (h ? h * ratio : validViewBox?.[2] || width);
  height = h || width / ratio;
  // A viewBox describes vector units, not a desired bitmap resolution.
  // Give dimensionless icons enough pixels for readable callouts.
  const longest = Math.max(width, height);
  const scale = Math.min(
    !w && !h ? Math.max(1, 1024 / longest) : 1,
    ANNOTATED_MAX_SIDE / longest
  );
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  image.width = width;
  image.height = height;
  return { width, height };
}

/** Draws the callouts onto a copy of the image and exports it as PNG. */
export async function renderAnnotatedImage(
  image: CanvasImageSource,
  size: { width: number; height: number },
  items: readonly ImageCalloutRegion[]
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(
    1,
    ANNOTATED_MAX_SIDE / Math.max(size.width, size.height)
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to create annotated copy.");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const c of items) {
    const x = c.x * canvas.width,
      y = c.y * canvas.height;
    ctx.strokeStyle = seatClasses(c.number).color;
    ctx.lineWidth = Math.max(3, canvas.width / 400);
    if (c.width || c.height)
      ctx.strokeRect(x, y, c.width * canvas.width, c.height * canvas.height);
    const r = Math.max(14, canvas.width / 80),
      bx = Math.max(r, Math.min(canvas.width - r, x)),
      by = Math.max(r, Math.min(canvas.height - r, y));
    ctx.fillStyle = seatClasses(c.number).ink;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${r}px sans-serif`;
    ctx.fillText(String(c.number), bx, by);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Unable to export image."))),
      "image/png"
    )
  );
  return { blob, width: canvas.width, height: canvas.height };
}

/** The `dispatch.image-feedback.v2` record attached beside an annotated copy. */
export function imageFeedbackMetadata({
  shareId,
  original,
  derivedFileId,
  derivedSize,
  items,
}: {
  shareId: string;
  original: {
    fileId: number;
    name: string;
    url?: string;
    updatedAt?: string;
    width: number;
    height: number;
  };
  derivedFileId: number;
  derivedSize: { width: number; height: number };
  items: readonly ImageCalloutRegion[];
}) {
  return {
    schema: "dispatch.image-feedback.v2",
    shareId,
    original,
    derivedFileId,
    derivedSize,
    sourceLocation: window.location.pathname + window.location.search,
    annotations: items.map((c) => ({
      id: c.id,
      number: c.number,
      color: seatClasses(c.number).color,
      region: {
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        units: "normalized",
        origin: "top-left",
      },
      note: c.note.trim(),
    })),
  };
}

/** Captions on the two attachments a feedback message carries. */
export const imageFeedbackCaptions = {
  copy: (fileName: string) => `Feedback on ${fileName}`,
  metadata: "Image and callout details",
};
