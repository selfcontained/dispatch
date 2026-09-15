import type { AgentRecord } from "@dispatch/shared";

import {
  buildLaunchGuidance,
  extractAppendedSystemPrompt,
} from "../tmux/command-builder.js";

const HARNESS_SLASH_RULE =
  'A user message that begins with "/<name>" names a slash command or skill: run it, treating the rest of the message as its input. If none has that name, say so briefly.';

export const HARNESS_CHAT_RULE =
  "The user is reading the Chat tab. Your replies appear there as you write them, so answer in plain text and do not repeat a reply through dispatch_chat_post. Use dispatch_chat_post only for a question that needs a choice (kind: question with options).";

/**
 * ACP takes a single persona string, unlike CLI agents' separate
 * `--append-system-prompt` flags.
 */
export function buildHarnessPersona(input: {
  agent: Pick<
    AgentRecord,
    "id" | "type" | "agentArgs" | "persona" | "autoReview"
  >;
  personalityPrompt: string | null;
  trimmedGuidance: boolean;
  suggestSessionRename: boolean;
  /** A job run: the guidance names the job tools (job_complete, …). */
  jobRunId?: string | null;
}): string {
  const { agent } = input;
  // Disable CLI chat guidance: streamed replies would otherwise be posted twice.
  const guidance = buildLaunchGuidance(agent.id, {
    agentType: agent.type,
    ...(input.jobRunId ? { jobRunId: input.jobRunId } : {}),
    suggestSessionRename: input.suggestSessionRename,
    autoReview: !agent.persona && agent.autoReview,
    trimmedGuidance: input.trimmedGuidance,
    chatSurface: false,
  });
  const { appendedSystemPrompt } = extractAppendedSystemPrompt(
    agent.agentArgs ?? []
  );
  const sections = [
    guidance.trim(),
    HARNESS_CHAT_RULE,
    HARNESS_SLASH_RULE,
    "Use dispatch_background_process for long-running non-interactive commands such as tests, builds, or bounded monitoring. It returns immediately and queues a completion message automatically; do not poll or wait for it. Continue independent work, or tell the user what is running and end the turn. Keep heavy validation jobs sequential to avoid exhausting the host. Use inspect to read output and stop to cancel your own process.",
    "For work with multiple steps, use dispatch_update_tasks to publish a short task list before starting. Send the full updated list as work progresses, marking tasks in_progress or completed. Keep it current when the user changes scope. Skip the task list for simple questions or one-step actions. This list is shown above the chat composer.",
  ];
  if (appendedSystemPrompt?.trim()) sections.push(appendedSystemPrompt.trim());
  else if (input.personalityPrompt?.trim()) {
    sections.push(input.personalityPrompt.trim());
  }
  return sections.join("\n\n");
}
