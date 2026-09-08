import type { AgentRecord } from "@dispatch/shared";

import {
  buildLaunchGuidance,
  extractAppendedSystemPrompt,
} from "../tmux/command-builder.js";

/** The Harness composer's slash menu sends "/<skill> …" as plain text. */
const HARNESS_SLASH_RULE =
  'A user message that begins with "/<name>" names a slash command or skill: run it, treating the rest of the message as its input. If none has that name, say so briefly.';

/** How a harness agent's output reaches the user; replaces the pane-era chat rule. */
export const HARNESS_CHAT_RULE =
  "The user is reading the Chat tab. Your replies appear there as you write them, so answer in plain text and do not repeat a reply through dispatch_chat_post. Use dispatch_chat_post only for a question that needs a choice (kind: question with options).";

/**
 * The system-prompt persona for a harness agent. CLI agents get the same
 * pieces as separate `--append-system-prompt` flags; the harness takes one
 * persona string (in `_meta.systemPrompt.append` for Claude, as the first
 * prompt's leading block for the other engines), so this joins them.
 */
export function buildHarnessPersona(input: {
  agent: Pick<
    AgentRecord,
    "id" | "type" | "agentArgs" | "persona" | "autoReview"
  >;
  personalityPrompt: string | null;
  trimmedGuidance: boolean;
  /** Accepted for parity with the CLI inputs; the harness always assumes Chat. */
  chatSurface?: boolean;
  suggestSessionRename: boolean;
  /** A job run: the guidance names the job tools (job_complete, …). */
  jobRunId?: string | null;
}): string {
  const { agent } = input;
  // The pane-driven chat rule sends replies through dispatch_chat_post; a
  // harness agent's text already streams into Chat, so that rule would make
  // it answer twice. It gets its own rule below instead.
  const guidance = buildLaunchGuidance(agent.id, {
    agentType: agent.type,
    ...(input.jobRunId ? { jobRunId: input.jobRunId } : {}),
    suggestSessionRename: input.suggestSessionRename,
    autoReview: !agent.persona && agent.autoReview,
    trimmedGuidance: input.trimmedGuidance,
    chatSurface: false,
  });
  // A persona launch stores its brief as `--append-system-prompt <text>`
  // in agentArgs.
  const { appendedSystemPrompt } = extractAppendedSystemPrompt(
    agent.agentArgs ?? []
  );
  const sections = [guidance.trim(), HARNESS_CHAT_RULE, HARNESS_SLASH_RULE];
  if (appendedSystemPrompt?.trim()) sections.push(appendedSystemPrompt.trim());
  else if (input.personalityPrompt?.trim()) {
    sections.push(input.personalityPrompt.trim());
  }
  return sections.join("\n\n");
}
