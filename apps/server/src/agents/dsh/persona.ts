import type { AgentRecord } from "@dispatch/shared";

import {
  buildLaunchGuidance,
  extractAppendedSystemPrompt,
} from "../tmux/command-builder.js";

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
  chatSurface: boolean;
  suggestSessionRename: boolean;
}): string {
  const { agent } = input;
  const guidance = buildLaunchGuidance(agent.id, {
    agentType: agent.type,
    suggestSessionRename: input.suggestSessionRename,
    autoReview: !agent.persona && agent.autoReview,
    trimmedGuidance: input.trimmedGuidance,
    chatSurface: input.chatSurface,
  });
  // A persona launch stores its brief as `--append-system-prompt <text>`
  // in agentArgs.
  const { appendedSystemPrompt } = extractAppendedSystemPrompt(
    agent.agentArgs ?? []
  );
  const sections = [guidance.trim()];
  if (appendedSystemPrompt?.trim()) sections.push(appendedSystemPrompt.trim());
  else if (input.personalityPrompt?.trim()) {
    sections.push(input.personalityPrompt.trim());
  }
  return sections.join("\n\n");
}
