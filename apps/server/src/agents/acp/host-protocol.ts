import path from "node:path";

import type { DriverEvent } from "./driver.js";
import type { AcpEngineId, EngineBins } from "./engine-spec.js";

/**
 * What the server writes into an agent's state directory before spawning
 * its host. Everything the host needs to run the engine is here, so the
 * host takes no arguments beyond the directory. Mode 0600: it carries the
 * MCP token and the system prompt.
 */
export type HostLaunch = {
  agentId: string;
  cwd: string;
  engine: AcpEngineId;
  bins: EngineBins;
  /** The model to select through the engine's model config option; null keeps its default. */
  model: string | null;
  /** Delivered as `_meta.systemPrompt.append` for engines that take one. */
  systemPrompt: string | null;
  mcp: { url: string; token: string };
  /** Environment the engine child gets on top of the host's own. */
  env: Record<string, string>;
  /** Directories prepended to the engine child's PATH. */
  pathPrefix: string[];
  /** The ACP session to resume when the host starts fresh; null for a new one. */
  resumeSessionId: string | null;
};

/** Files inside an agent's state directory. */
export const HOST_FILES = {
  launch: "launch.json",
  socket: "host.sock",
  pid: "host.pid",
  journal: "journal.jsonl",
  session: "session.json",
  log: "host.log",
} as const;

export function hostFile(
  stateDir: string,
  name: keyof typeof HOST_FILES
): string {
  return path.join(stateDir, HOST_FILES[name]);
}

/** One journal line: an event with its position in the host's stream. */
export type JournalEntry = { seq: number; at: string; event: DriverEvent };

export type ClientMessage =
  | { type: "hello"; fromSeq: number }
  | { type: "prompt"; id: string; text: string }
  | { type: "cancel" }
  | { type: "shutdown"; force?: boolean }
  | { type: "ping" };

export type HostMessage =
  | {
      type: "welcome";
      agentId: string;
      engine: AcpEngineId;
      sessionId: string;
      /** Whether the session was resumed from a stored id. */
      resumed: boolean;
      /** Whether the engine child is alive. */
      running: boolean;
      /** The open turn, if one is running. */
      turn: { seq: number; startedAt: string } | null;
      /** The newest journal seq; replay follows up to here. */
      journalSeq: number;
    }
  | ({ type: "event" } & JournalEntry)
  | { type: "prompt_accepted"; id: string }
  | { type: "error"; id?: string; message: string }
  | { type: "pong" };

/**
 * Split a byte stream into newline-delimited JSON messages. Returns a
 * function that takes each chunk and yields the complete messages in it;
 * a partial trailing line waits for the next chunk.
 */
export function ndjsonDecoder<T>(): (chunk: Buffer | string) => T[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const out: T[] = [];
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A corrupt line is dropped rather than poisoning the stream.
      }
    }
    return out;
  };
}

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
