import { open, stat } from "node:fs/promises";
import path from "node:path";

import { cwdToClaudeProjectDir } from "./token-harvester.js";

const MAX_TAIL_BYTES = 256 * 1024;
const SESSION_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type ProviderSessionState =
  | { state: "complete"; reason: string }
  | { state: "interrupted"; reason: string }
  | { state: "unknown"; reason: string };

async function readJsonlTail(
  filePath: string
): Promise<Record<string, unknown>[] | null> {
  let before: Awaited<ReturnType<typeof stat>>;
  try {
    before = await stat(filePath);
  } catch {
    return null;
  }
  if (!before.isFile() || before.size === 0) return [];

  const start = Math.max(0, before.size - MAX_TAIL_BYTES);
  const length = before.size - start;
  const handle = await open(filePath, "r");
  let bytesRead = 0;
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(length);
    ({ bytesRead } = await handle.read(buffer, 0, length, start));
  } finally {
    await handle.close();
  }

  const after = await stat(filePath).catch(() => null);
  if (
    !after ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    return null;
  }

  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const newline = text.indexOf("\n");
    if (newline < 0) return null;
    text = text.slice(newline + 1);
  }
  const lines = text.split("\n");
  if (lines.at(-1)?.trim()) return null;
  lines.pop();

  const entries: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
      entries.push(parsed as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  return entries;
}

function assistantStopReason(entry: Record<string, unknown>): unknown {
  if (entry.type !== "assistant") return undefined;
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    return undefined;
  return (message as Record<string, unknown>).stop_reason;
}

function isHumanUserEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user") return false;
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    return false;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return !content.every(
    (part) =>
      !!part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      (part as Record<string, unknown>).type === "tool_result"
  );
}

function isToolResultEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user") return false;
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    return false;
  const content = (message as Record<string, unknown>).content;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        !!part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "tool_result"
    )
  );
}

export function classifyClaudeSessionEntries(
  entries: Record<string, unknown>[]
): ProviderSessionState {
  let lastTurnDuration = -1;
  let lastAssistant = -1;
  let lastHumanUser = -1;
  let lastToolResult = -1;

  entries.forEach((entry, index) => {
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      lastTurnDuration = index;
    }
    if (
      entry.type === "assistant" &&
      assistantStopReason(entry) !== undefined
    ) {
      lastAssistant = index;
    }
    if (isHumanUserEntry(entry)) lastHumanUser = index;
    if (isToolResultEntry(entry)) lastToolResult = index;
  });

  const lastSemantic = Math.max(lastAssistant, lastHumanUser, lastToolResult);
  if (lastTurnDuration > lastSemantic) {
    return { state: "complete", reason: "turn-duration" };
  }
  if (lastHumanUser > lastAssistant) {
    return { state: "interrupted", reason: "unanswered-user-message" };
  }
  if (lastToolResult > lastAssistant) {
    return { state: "interrupted", reason: "tool-result-without-follow-up" };
  }
  if (lastAssistant >= 0) {
    const reason = assistantStopReason(entries[lastAssistant]!);
    if (reason === "end_turn" || reason === "stop_sequence") {
      return { state: "complete", reason: `assistant-${reason}` };
    }
    if (reason === "tool_use" || reason === null) {
      return {
        state: "interrupted",
        reason:
          reason === "tool_use"
            ? "dangling-tool-use"
            : "incomplete-assistant-chunk",
      };
    }
  }
  return { state: "unknown", reason: "no-decisive-turn-marker" };
}

export async function inspectClaudeSessionState(
  cwd: string,
  sessionId: string
): Promise<ProviderSessionState> {
  if (!SESSION_ID_RE.test(sessionId)) {
    return { state: "unknown", reason: "invalid-session-id" };
  }
  const filePath = path.join(cwdToClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  const entries = await readJsonlTail(filePath);
  if (entries === null)
    return { state: "unknown", reason: "missing-or-changing-log" };
  if (entries.length === 0) return { state: "unknown", reason: "empty-log" };
  return classifyClaudeSessionEntries(entries);
}
