import type { AgentRecord } from "@dispatch/shared";

import { buildLaunchGuidance } from "../launch-guidance.js";

const SLASH_RULE =
  'A user message that begins with "/<name>" names a slash command or skill: run it, treating the rest of the message as its input. If none has that name, say so briefly.';

export const CHAT_RULE =
  'The user reads your stream. Your replies appear there as you write them, so answer in plain text and never repeat a reply through post. Use post for what plain text cannot do: a question with options, a form, a file (attachments: [{ type: "file", path }]), a link, a review of another agent\'s work, a checklist, or a message to another agent (to). Reply to a DISPATCH POST from another agent only when it asks for one.';

/**
 * Pull a `--append-system-prompt <value>` pair out of stored agent args.
 * Older agents carried their extra system prompt this way; the ACP session
 * takes one string, so it is folded in here.
 */
export function extractAppendedSystemPrompt(
  args: readonly string[]
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (
      args[index] === "--append-system-prompt" &&
      typeof args[index + 1] === "string"
    ) {
      return args[index + 1] ?? null;
    }
  }
  return null;
}

/**
 * The one system prompt an ACP session gets: the Dispatch launch guidance,
 * the chat rules, and the active personality (or an explicit appended
 * prompt, which wins over the personality as it did for CLI launches).
 */
export function buildSystemPrompt(input: {
  agent: Pick<AgentRecord, "id" | "type" | "agentArgs" | "persona">;
  personalityPrompt: string | null;
  trimmedGuidance: boolean;
  suggestSessionRename: boolean;
  /** A job run: the guidance names the job tools (job_complete, …). */
  jobRunId?: string | null;
}): string {
  const { agent } = input;
  const guidance = buildLaunchGuidance(agent.id, {
    agentType: agent.type,
    ...(input.jobRunId ? { jobRunId: input.jobRunId } : {}),
    suggestSessionRename: input.suggestSessionRename,
    trimmedGuidance: input.trimmedGuidance,
  });
  const appended = extractAppendedSystemPrompt(agent.agentArgs ?? []);
  const sections = [guidance.trim(), CHAT_RULE, SLASH_RULE];
  if (appended?.trim()) sections.push(appended.trim());
  else if (input.personalityPrompt?.trim()) {
    sections.push(input.personalityPrompt.trim());
  }
  return sections.join("\n\n");
}
