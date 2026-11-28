export type FileMedia = "image" | "video" | "pdf" | "text" | "file";

/** The `media` a file of this MIME type gets. */
export function fileMedia(mimeType: string | undefined): FileMedia {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return "text";
  }
  return "file";
}
