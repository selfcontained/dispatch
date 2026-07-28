/**
 * File-type tables and predicates for agent media uploads.
 *
 * Single source of truth shared by the server (upload validation, MIME
 * lookup) and the web client (file-picker accept list, media viewers,
 * clipboard uploads) — web imports this module directly across the
 * workspace boundary (see apps/web/src/lib/media-accept.ts). Keep it
 * dependency-free: no node imports, no browser globals.
 */

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const VIDEO_EXTENSIONS = [".mp4"];
const DOCUMENT_EXTENSION_LIST = [".pdf"];

const TEXT_EXTENSION_LIST = [
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".diff",
  ".patch",
  ".env",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".swift",
  ".kt",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".lua",
  ".zig",
  ".nim",
  ".r",
  ".m",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
];

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  TEXT_EXTENSION_LIST
);
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(
  DOCUMENT_EXTENSION_LIST
);
const IMAGE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

/** Lower-cased extension including the leading dot, or "" when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isTextFile(name: string): boolean {
  const ext = fileExtension(name);
  return ext !== "" && TEXT_EXTENSIONS.has(ext);
}

export function isDocumentFile(name: string): boolean {
  return DOCUMENT_EXTENSIONS.has(fileExtension(name));
}

export function isMediaFile(name: string): boolean {
  return (
    IMAGE_VIDEO_EXTENSIONS.has(fileExtension(name)) ||
    isTextFile(name) ||
    isDocumentFile(name)
  );
}

/** Every accepted upload extension, as an `accept=""`-ready comma list. */
export const MEDIA_UPLOAD_ACCEPT = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...DOCUMENT_EXTENSION_LIST,
  ...TEXT_EXTENSION_LIST,
].join(",");

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

/** Map a MIME type to a file extension (with leading dot). */
export function extensionForMime(mime: string): string {
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  if (mime.startsWith("image/")) return ".png";
  return ".bin";
}
