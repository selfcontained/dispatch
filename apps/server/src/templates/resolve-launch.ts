import type { Effort } from "@dispatch/shared";
import { validateAgentEffort } from "../shared/agent-effort.js";
import { AGENT_TYPES, type AgentType } from "../agent-type-settings.js";
import { validateAgentModel } from "../shared/agent-models.js";
import {
  normalizeBaseBranch,
  assertSafeRefName,
} from "../shared/git/worktree.js";
import { templateWorktreeConfig } from "./worktree-config.js";
import type { TemplateRecord } from "./store.js";

/** One resolution rule for previews and launches, including CLI default on runtime changes. */
export function resolveTemplateLaunch(
  template: TemplateRecord,
  overrides: {
    agentType?: AgentType;
    model?: string | null;
    effort?: Effort | null;
  } = {}
): TemplateRecord {
  const agentType = overrides.agentType ?? template.agentType;
  if (!AGENT_TYPES.includes(agentType))
    throw new Error(`Unsupported agent type "${agentType}".`);
  const model =
    overrides.model !== undefined
      ? overrides.model
      : agentType === template.agentType
        ? template.model
        : null;
  const workspace = templateWorktreeConfig(template);
  const baseBranch = workspace.baseBranch?.trim()
    ? normalizeBaseBranch(workspace.baseBranch)
    : workspace.useWorktree
      ? "main"
      : null;
  const branchName = workspace.worktreeBranch?.trim()
    ? assertSafeRefName(workspace.worktreeBranch, "worktreeBranch")
    : null;
  return {
    ...template,
    agentType,
    model: validateAgentModel(agentType, model ?? undefined) ?? null,
    effort: validateAgentEffort(
      agentType,
      overrides.effort ?? template.effort,
      model
    ),
    persona: template.persona ?? null,
    fullAccess: template.fullAccess ?? false,
    useWorktree: workspace.useWorktree,
    baseBranch,
    branchName,
  };
}
