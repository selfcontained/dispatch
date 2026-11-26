import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function taskAttachmentDirectory(
  filesRoot: string | undefined,
  taskId: string
) {
  if (!filesRoot) throw new Error("Task file storage is unavailable.");
  return path.resolve(filesRoot, "tasks", taskId);
}

export function taskAttachmentPath(
  filesRoot: string | undefined,
  taskId: string,
  fileName: string
) {
  return path.join(taskAttachmentDirectory(filesRoot, taskId), fileName);
}

export function createTaskAttachmentDirectory(
  filesRoot: string | undefined,
  taskId: string
) {
  return mkdir(taskAttachmentDirectory(filesRoot, taskId), { recursive: true });
}

export function writeTaskAttachment(
  filesRoot: string | undefined,
  taskId: string,
  fileName: string,
  bytes: Buffer
) {
  return writeFile(taskAttachmentPath(filesRoot, taskId, fileName), bytes);
}

export function removeTaskAttachments(filesRoot: string, taskId: string) {
  return rm(taskAttachmentDirectory(filesRoot, taskId), {
    recursive: true,
    force: true,
  });
}
