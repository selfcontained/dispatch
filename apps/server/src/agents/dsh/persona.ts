import type { AgentRecord } from "@dispatch/shared";

import {
  buildLaunchGuidance,
  extractAppendedSystemPrompt,
} from "../tmux/command-builder.js";

/** How a dsh agent's output reaches the user; replaces the pane-era chat rule. */
/** The Harness composer's slash menu sends "/<skill> …" as plain text. */
export const DSH_SLASH_RULE =
  'A user message that begins with "/<name>" names a skill: load that skill with the skill tool and follow it, treating the rest of the message as its input. If no skill has that name, say so briefly.';

export const DSH_CHAT_RULE =
  "The user is reading the Chat tab. Your replies appear there as you write them, so answer in plain text and do not repeat a reply through dispatch_chat_post. Use dispatch_chat_post only for a question that needs a choice (kind: question with options).";

/**
 * The system-prompt persona for a dsh agent. CLI agents get the same pieces
 * as separate `--append-system-prompt` flags; dsh takes one persona string
 * through the overlay (see overlay.ts), so this joins them: the Dispatch
 * launch guidance first, then the persona brief a review launch stored in
 * `agentArgs`, or the active personality for a standard agent.
 *
 * `{{model}}` and `{{cwd}}` are dsh prompt variables; the guidance text does
 * not use them, so nothing here needs escaping.
 */
export function buildDshPersona(input: {
  agent: Pick<
    AgentRecord,
    "id" | "type" | "agentArgs" | "persona" | "autoReview"
  >;
  personalityPrompt: string | null;
  trimmedGuidance: boolean;
  /** Accepted for parity with the CLI inputs; dsh always assumes Chat. */
  chatSurface?: boolean;
  suggestSessionRename: boolean;
  /** A job run: the guidance names the job tools (job_complete, …). */
  jobRunId?: string | null;
}): string {
  const { agent } = input;
  // The pane-driven chat rule sends replies through dispatch_chat_post; a
  // dsh agent's text already streams into Chat, so that rule would make it
  // answer twice. It gets its own rule below instead.
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
  const sections = [guidance.trim(), DSH_CHAT_RULE, DSH_SLASH_RULE];
  if (appendedSystemPrompt?.trim()) sections.push(appendedSystemPrompt.trim());
  else if (input.personalityPrompt?.trim()) {
    sections.push(input.personalityPrompt.trim());
  }
  return sections.join("\n\n");
}
