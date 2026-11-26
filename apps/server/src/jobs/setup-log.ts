import { readFile } from "node:fs/promises";

/** Earlier Dispatch releases wrote agent setup stderr here through tmux. */
export async function readSetupLogTail(agentId: string): Promise<string> {
  const text = await readFile(
    `/tmp/dispatch_setup_${agentId}.log`,
    "utf8"
  ).catch(() => "");
  const trimmed = text.trim();
  return trimmed
    ? `Setup log tail:\n${trimmed.split("\n").slice(-20).join("\n")}`
    : "";
}
