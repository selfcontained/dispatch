import path from "node:path";

import { resolveConfiguredPath } from "./lib/resolve-tilde.js";

import { extensionForMime, isDocumentFile, isTextFile } from "./file-types.js";

export { extensionForMime, isDocumentFile, isTextFile };

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

export function resolveFilesDir(
  agentId: string,
  filesDir: string | null,
  filesRoot: string
): string {
  return resolveConfiguredPath(filesDir ?? path.join(filesRoot, agentId));
}

export function toFileKey(file: { name: string; updatedAt: string }): string {
  return `${file.name}:${file.updatedAt}`;
}

export function isValidFileKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) {
    return false;
  }
  return !/[\u0000-\u001F]/.test(key);
}
