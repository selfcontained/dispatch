import path from "node:path";

export function sanitizeUploadedFileName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const baseName = path.basename(name, path.extname(name)).normalize("NFKD");
  const collapsed = baseName
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._() -]+/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${collapsed || "file"}${ext}`;
}

const TEXT_EXTENSIONS = new Set([
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
]);

export function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

const DOCUMENT_EXTENSIONS = new Set([".pdf"]);

export function isDocumentFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext);
}

export function isMediaFile(name: string): boolean {
  return (
    /\.(png|jpg|jpeg|gif|webp|mp4)$/i.test(name) ||
    isTextFile(name) ||
    isDocumentFile(name)
  );
}

export function mimeType(name: string): string {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.mp4$/i.test(name)) return "video/mp4";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.xml$/i.test(name)) return "application/xml";
  if (/\.html$/i.test(name)) return "text/html";
  if (/\.css$/i.test(name)) return "text/css";
  if (/\.(js|jsx|mjs)$/i.test(name)) return "text/javascript";
  if (/\.csv$/i.test(name)) return "text/csv";
  if (/\.md$/i.test(name)) return "text/markdown";
  if (/\.ya?ml$/i.test(name)) return "text/yaml";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (isTextFile(name)) return "text/plain";
  return "application/octet-stream";
}

export function resolveMediaDir(
  agentId: string,
  mediaDir: string | null,
  mediaRoot: string
): string {
  return mediaDir ?? path.join(mediaRoot, agentId);
}

export function toMediaKey(file: { name: string; updatedAt: string }): string {
  return `${file.name}:${file.updatedAt}`;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

export function extensionForMime(mime: string): string {
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  if (mime.startsWith("image/")) return ".png";
  return ".bin";
}

export function isValidMediaKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) {
    return false;
  }
  return !/[\u0000-\u001F]/.test(key);
}
