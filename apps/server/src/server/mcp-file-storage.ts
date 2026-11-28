import { mkdir, unlink, writeFile } from "node:fs/promises";

export function createPublishedFilesDirectory(filesDir: string) {
  return mkdir(filesDir, { recursive: true });
}

export function writePublishedFile(filePath: string, bytes: Buffer) {
  return writeFile(filePath, bytes);
}

export async function unlinkPublishedFile(filePath: string) {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
}
