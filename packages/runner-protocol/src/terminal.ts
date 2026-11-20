import { isBase64, isRecord } from "./validation.js";

export const TERMINAL_REPLAY_BYTES = 256 * 1024;
export const MAX_TERMINAL_INPUT_BYTES = 16 * 1024;
export const MAX_TERMINAL_FRAME_LENGTH = 512 * 1024;

export type TerminalInfo = { cwd: string; host: string; user: string };
export type TerminalControl =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" | "resume" };
export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

const utf8 = new TextEncoder();

export function isTerminalControl(value: unknown): value is TerminalControl {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "input":
      return (
        typeof value.data === "string" &&
        value.data.length <= MAX_TERMINAL_INPUT_BYTES &&
        utf8.encode(value.data).length <= MAX_TERMINAL_INPUT_BYTES
      );
    case "resize":
      return (
        typeof value.cols === "number" &&
        Number.isInteger(value.cols) &&
        value.cols >= 2 &&
        value.cols <= 500 &&
        typeof value.rows === "number" &&
        Number.isInteger(value.rows) &&
        value.rows >= 1 &&
        value.rows <= 200
      );
    case "detach":
    case "resume":
      return true;
    default:
      return false;
  }
}

export function isTerminalInfo(value: unknown): value is TerminalInfo {
  return (
    isRecord(value) &&
    [value.cwd, value.host, value.user].every(
      (field) =>
        typeof field === "string" && field.length > 0 && field.length <= 8192
    )
  );
}

export function isTerminalEvent(value: unknown): value is TerminalEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "output":
      return (
        isBase64(value.data) &&
        value.data.length <= Math.ceil(TERMINAL_REPLAY_BYTES / 3) * 4
      );
    case "exit":
      return typeof value.code === "number" && Number.isInteger(value.code);
    case "error":
      return typeof value.message === "string" && value.message.length <= 1024;
    default:
      return false;
  }
}
