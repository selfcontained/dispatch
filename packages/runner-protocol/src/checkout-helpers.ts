/**
 * A checkout read's failure with the HTTP status the app answers it with.
 * Raised by the workload's views, and rebuilt by the app from a runner's
 * error details so both give the same answer.
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export function workspaceViewError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ESTALE")
    return new WorkspaceError("Directory changed. Refresh to retry.", 409);
  if (code === "ENOENT" || code === "ENOTDIR")
    return new WorkspaceError("File or workspace no longer exists.", 404);
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP")
    return new WorkspaceError("This path cannot be read.", 403);
  return new WorkspaceError("Unable to read workspace.", 500);
}

const RASTER_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export function imageMimeType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return Object.hasOwn(RASTER_MIME, ext) ? RASTER_MIME[ext]! : null;
}
export function isImageFile(name: string): boolean {
  return imageMimeType(name) !== null;
}
