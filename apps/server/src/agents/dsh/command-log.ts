import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * A per-agent log of the shell commands the harness ran, written as they
 * settle. dsh executes in its own process, so the agent's Console pane
 * cannot be that shell; instead the pane tails this file above an
 * interactive shell, so the Console doubles as the agent's command log.
 */
export function commandLogPath(dshHome: string, agentId: string): string {
  return path.join(dshHome, "logs", `${agentId}.log`);
}

export type CommandLogEntry = {
  command: string;
  output: string | null;
  status: "completed" | "failed";
  durationMs: number;
  at: Date;
};

const DIM = "[2m";
const BOLD = "[1m";
const RED = "[31m";
const RESET = "[0m";

/** One entry as `tail -F` shows it: a prompt line, the output, a footer. */
export function formatCommandLogEntry(entry: CommandLogEntry): string {
  const time = entry.at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const head = `${DIM}${time}${RESET} ${BOLD}$${RESET} ${entry.command}`;
  const body = entry.output?.replace(/\n$/, "") ?? "";
  const status =
    entry.status === "failed" ? `${RED}failed${RESET}` : `${DIM}ok${RESET}`;
  const foot = `${DIM}└${RESET} ${status} ${DIM}· ${Math.round(entry.durationMs)}ms${RESET}`;
  return `${head}\n${body ? `${body}\n` : ""}${foot}\n\n`;
}

export async function appendCommandLog(
  file: string,
  entry: CommandLogEntry
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, formatCommandLogEntry(entry), "utf8");
}
