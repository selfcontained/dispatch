import path from "node:path";

import { resolveConfiguredPath } from "./lib/resolve-tilde.js";

import {
  extensionForMime,
  isDocumentFile,
  isMediaFile,
  isTextFile,
} from "./media-file-types.js";

export { extensionForMime, isDocumentFile, isMediaFile, isTextFile };

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
  return resolveConfiguredPath(mediaDir ?? path.join(mediaRoot, agentId));
}

export function toMediaKey(file: { name: string; updatedAt: string }): string {
  return `${file.name}:${file.updatedAt}`;
}

export function isValidMediaKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) {
    return false;
  }
  return !/[\u0000-\u001F]/.test(key);
}
