/**
 * Display-sized copies of stored images.
 *
 * `GET /api/v1/agents/:id/files/:file?w=<px>` serves a copy of a PNG or JPEG
 * at one of these widths, or the original when it can't (other formats,
 * images already that narrow, failures). Previews list the copies in
 * `srcset` and let the browser pick the one that fits the box at the
 * screen's pixel density. Lightbox and download keep the original URL.
 */
export const IMAGE_VARIANT_WIDTHS = [320, 640, 1280] as const;

/** `url` with `w=<width>` added, keeping any query it already has. */
export function imageVariantUrl(url: string, width: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}

/**
 * A `srcset` of the copies narrower than the image, plus the original at its
 * own width when that is known. Without a known width every copy is listed;
 * the server answers one wider than the image with the original.
 */
export function imageVariantSrcSet(url: string, naturalWidth?: number): string {
  const candidates: string[] = [];
  for (const width of IMAGE_VARIANT_WIDTHS) {
    if (naturalWidth && width >= naturalWidth) break;
    candidates.push(`${imageVariantUrl(url, width)} ${width}w`);
  }
  if (naturalWidth) candidates.push(`${url} ${naturalWidth}w`);
  return candidates.join(", ");
}
