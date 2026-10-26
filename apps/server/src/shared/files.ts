import path from "node:path";

import { resolveConfiguredPath } from "./lib/resolve-tilde.js";

import { extensionForMime, isDocumentFile, isTextFile } from "./file-types.js";

export { extensionForMime, isDocumentFile, isTextFile };

// Filesystem components are limited to 255 bytes on supported APFS/ext4 hosts.
// Allow a fully percent-encoded component (three URL characters per byte).
export const MAX_STORED_FILE_NAME_BYTES = 255;
export const MAX_ENCODED_FILE_NAME_LENGTH = MAX_STORED_FILE_NAME_BYTES * 3;

export function isValidStoredFileName(name: string): boolean {
  return (
    Buffer.byteLength(name, "utf8") <= MAX_STORED_FILE_NAME_BYTES &&
    /^[A-Za-z0-9._() -]+$/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

export function assertValidStoredFileName(name: string): void {
  if (!isValidStoredFileName(name)) {
    throw new Error(
      `Invalid file name. Use letters, numbers, spaces, dots, underscores, hyphens or parentheses, with at most ${MAX_STORED_FILE_NAME_BYTES} bytes including any generated suffix. Shorten the name if needed.`
    );
  }
}

export function timestampedFileName(
  name: string,
  createdAt = new Date(),
  suffix = ""
): string {
  assertValidStoredFileName(name);
  const timestamp = createdAt
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .replace("Z", "");
  const ext = path.extname(name);
  const result = `${path.basename(name, ext)}-${timestamp}${suffix}${ext}`;
  assertValidStoredFileName(result);
  return result;
}

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
