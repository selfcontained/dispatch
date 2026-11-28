import { targetPlacement } from "../runners/saved-location.js";
import type { Effort } from "@dispatch/shared";
import { validateAgentEffort } from "../shared/agent-effort.js";
import { AGENT_TYPES, type AgentType } from "../agent-type-settings.js";
import { modelScopeFor, validateAgentModel } from "../shared/agent-models.js";
import {
  normalizeBaseBranch,
  assertSafeRefName,
} from "@dispatch/runner-protocol";
import { templateWorktreeConfig } from "./worktree-config.js";
import type { TemplateRecord } from "./store.js";

/**
 * One resolution rule for previews and launches, including CLI default on
 * runtime changes. The model and effort are checked against the catalog of
 * the machine the launch targets (`target`, else the template's directory);
 * a runner that can't report one validates the override at launch.
 */
export async function resolveTemplateLaunch(
  template: TemplateRecord,
  overrides: {
    agentType?: AgentType;
    model?: string | null;
    effort?: Effort | null;
  } = {},
  target = targetPlacement(template)
): Promise<TemplateRecord> {
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
    : null;
  const branchName = workspace.worktreeBranch?.trim()
    ? assertSafeRefName(workspace.worktreeBranch, "worktreeBranch")
    : null;
  const scope = await modelScopeFor(target, agentType, {
    model,
    effort:
      overrides.effort !== undefined
        ? overrides.effort
        : agentType === template.agentType && model === template.model
          ? template.effort
          : null,
  });
  return {
    ...template,
    agentType,
    model: validateAgentModel(agentType, model ?? undefined, scope) ?? null,
    effort: validateAgentEffort(
      agentType,
      overrides.effort !== undefined
        ? overrides.effort
        : agentType === template.agentType && model === template.model
          ? template.effort
          : null,
      model,
      scope
    ),
    persona: template.persona ?? null,
    fullAccess: agentType === "opencode" || (template.fullAccess ?? false),
    useWorktree: workspace.useWorktree,
    baseBranch,
    branchName,
  };
}
