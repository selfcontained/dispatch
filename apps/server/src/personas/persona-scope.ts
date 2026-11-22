import { remotePlacement } from "@dispatch/runner-protocol";
import type { AgentManager, AgentRecord } from "../agents/manager.js";

type SessionCheckout = {
  agent: AgentRecord;
  manager: Pick<AgentManager, "inspectCheckout">;
};

export type PersonaScope =
  | ({ kind: "session" } & SessionCheckout)
  | { kind: "folder"; cwd: string; source: "catalog" | "workspace" }
  | { kind: "project"; repoRoot: string }
  | { kind: "builtins" };

/** Chooses where a persona saved on a job or template is resolved. */
export type SavedPersonaScope = (target: {
  cwd: string;
  projectRoot?: string;
}) => PersonaScope;

export function personaScopeFor(
  target:
    | SessionCheckout
    | {
        cwd?: string;
        projectRoot?: string;
        source?: "catalog" | "workspace";
      }
): PersonaScope {
  if ("agent" in target) return { kind: "session", ...target };
  if (target.cwd && !remotePlacement(target.cwd))
    return {
      kind: "folder",
      cwd: target.cwd,
      source: target.source ?? "catalog",
    };
  return target.projectRoot
    ? { kind: "project", repoRoot: target.projectRoot }
    : { kind: "builtins" };
}
