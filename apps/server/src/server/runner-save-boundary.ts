import { remotePlacement } from "@dispatch/runner-protocol";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  personaScopeFor,
  type SavedPersonaScope,
} from "../personas/persona-scope.js";

/**
 * What a runner agent may save through its job and template tools. A path it
 * names means nothing on the controller, so the only folder it can choose is
 * its own runner workspace, personas for which are read from its session.
 * Refusals are decided from the strings alone: they never touch, and so never
 * describe, the controller's disk. Null for an agent on the controller.
 */
export function runnerSaveBoundary(
  manager: Pick<AgentManager, "inspectCheckout">,
  agent: AgentRecord
): {
  assertTarget(input: { directory?: string; projectId?: string | null }): void;
  personaScope: SavedPersonaScope;
} | null {
  const home = remotePlacement(agent.cwd);
  if (!home) return null;

  function assertWorkspace(directory: string) {
    const target = remotePlacement(directory);
    if (target?.runner !== home!.runner || target.workspace !== home!.workspace)
      throw new Error(
        `A runner agent can only use its own workspace (${agent.cwd}) for this. Omit directory to use it.`
      );
  }

  return {
    assertTarget({ directory, projectId }) {
      if (directory !== undefined) assertWorkspace(directory);
      if (projectId != null && projectId !== agent.projectId)
        throw new Error("A runner agent can only use its own project.");
    },
    // An update can keep a stored folder, so check the one being resolved.
    personaScope({ cwd }) {
      assertWorkspace(cwd);
      return personaScopeFor({ manager, agent });
    },
  };
}
