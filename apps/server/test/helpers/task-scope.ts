// Test wiring: the same reader port as production, with no child process.
import {
  agentTaskProject as scopedProject,
  runnerTaskRootReader,
} from "../../src/tasks/agent-scope.js";
export const readRepositoryRoot = runnerTaskRootReader(() => ({}));
export const agentTaskProject = (
  agent: Parameters<typeof scopedProject>[0],
  scope: Parameters<typeof scopedProject>[1]
) => scopedProject(agent, scope, readRepositoryRoot);

export { taskScopeInput } from "../../src/tasks/agent-scope.js";
