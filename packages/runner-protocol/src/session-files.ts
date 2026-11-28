import { isRecord } from "./validation.js";

/** A complete file fits within one v1 frame, including base64 overhead. */
export const MAX_SESSION_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SESSION_FILE_BASE64 =
  Math.ceil(MAX_SESSION_FILE_BYTES / 3) * 4;

/**
 * `deliver` carries its bytes inline (`data`, the v1 frame and its limit) or,
 * when the peer advertises `filesPutStream`, on the flow-controlled stream
 * `streamId`, with no size limit.
 */
export type SessionFileOperation =
  | { kind: "deliver"; name: string; data: string; streamId?: undefined }
  | {
      kind: "deliver";
      name: string;
      streamId: string;
      /** The byte count the stream must deliver; anything else is discarded. */
      size: number;
      data?: undefined;
    }
  | { kind: "collect"; path: string; streamId?: string };

export function isSessionFileData(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_SESSION_FILE_BASE64 ||
    value.length % 4 !== 0
  )
    return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (
    (value.length / 4) * 3 - padding <= MAX_SESSION_FILE_BYTES &&
    !/[^A-Za-z0-9+/]/u.test(value.slice(0, value.length - padding))
  );
}

/** One path component: the caller's naming rules apply, not the runner's. */
export function isSessionFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[/\0]/u.test(value)
  );
}

function isStreamId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isSessionFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f]/u.test(value) &&
    !value.split("/").includes("..")
  );
}

export function isSessionFileOperation(
  value: unknown
): value is SessionFileOperation {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "deliver":
      return (
        isSessionFileName(value.name) &&
        (value.streamId === undefined
          ? isSessionFileData(value.data)
          : value.data === undefined &&
            isStreamId(value.streamId) &&
            Number.isSafeInteger(value.size) &&
            (value.size as number) >= 0)
      );
    case "collect":
      return (
        typeof value.path === "string" &&
        value.path.length > 0 &&
        !value.path.includes("\0") &&
        (value.streamId === undefined || isStreamId(value.streamId))
      );
    default:
      return false;
  }
}
