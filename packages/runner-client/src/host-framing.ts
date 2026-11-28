import path from "node:path";
import { StringDecoder } from "node:string_decoder";
export { parseClientMessage } from "@dispatch/runner-protocol/host";
export type {
  HostLaunch,
  JournalEntry,
  PromptReceiptState,
  ClientMessage,
  HostMessage,
} from "@dispatch/runner-protocol/host";

/**
 * Every file the host, or whoever launches it, writes into an agent's state
 * directory. Name new files here so the runner can decide which state to
 * retain on relaunch.
 */
export const HOST_FILES = {
  launch: "launch.json",
  socket: "host.sock",
  pid: "host.pid",
  journal: "journal.jsonl",
  journalId: "journal.id",
  session: "session.json",
  log: "host.log",
  receipts: "prompt-receipts.jsonl",
  turnActive: "turn-active",
  serviceMcpCa: "service-mcp-ca.pem",
  nodeCa: "node-ca.pem",
  codexCa: "codex-ca.pem",
  curlCa: "curl-ca.pem",
  instructions: "dispatch-instructions.md",
  personaContext: "persona-context.md",
} as const;

export function hostFile(
  stateDir: string,
  name: keyof typeof HOST_FILES
): string {
  return path.join(stateDir, HOST_FILES[name]);
}

/**
 * Split a byte stream into newline-delimited JSON messages. Returns a
 * function that takes each chunk and yields the complete messages in it;
 * a partial trailing line waits for the next chunk.
 */
export function ndjsonDecoder<T>(
  onMalformed?: () => void
): (chunk: Buffer | string) => T[] {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const out: T[] = [];
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // Keep parsing subsequent lines after a malformed message.
        onMalformed?.();
      }
    }
    return out;
  };
}

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
