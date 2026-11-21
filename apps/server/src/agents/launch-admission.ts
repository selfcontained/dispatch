import { remotePlacement } from "@dispatch/runner-protocol";

import { errorMessage } from "../shared/lib/error-message.js";
import {
  parseRepositoryTarget,
  type RepositoryTarget,
} from "./remote/repository.js";
import type { AgentRecord, AgentRole } from "./types.js";

type LaunchCaller =
  | "createAgent"
  | "mcpChild"
  | "mcpIndependent"
  | "task"
  | "job"
  | "template"
  | "review";

type Workspace = "folder" | "managedRepository" | "configuredWorkspace";
type LaunchTarget = Workspace | { borrowed: Workspace };

type Capabilities = {
  available: boolean;
  sessionFiles: boolean;
  sharedWorktree: boolean;
};

type BindingIntent = {
  cwd: string;
  launchedByAgentId?: string;
  parentAgentId?: string;
  repository?: unknown;
  useWorktree?: boolean;
  projectId?: string | null;
  role?: AgentRole;
  persona?: string;
  fullAccess?: boolean;
};

type ApiRequest = {
  phase: "api";
  caller: "createAgent" | "task";
  target: Workspace;
  cwd: unknown;
  projectId?: string;
  taskProjectId?: string;
};

type McpRequest = {
  phase: "mcpTarget" | "mcpTemplate";
  caller: "mcpChild" | "mcpIndependent";
  sourceCwd: string;
  sourceWorkdir: string;
  sourceProjectId?: string | null;
  cwd?: string;
  template?: { directory: string; projectId?: string | null } | null;
};

type IndependentRequest = {
  phase: "independentBinding";
  input: BindingIntent;
  owner: AgentRecord | null;
  hasPersonaBody: boolean;
  borrowsCheckout: boolean;
};

type SharedRequest = {
  phase: "sharedBinding";
  input: BindingIntent;
  owner: AgentRecord | null;
  ownerWorkdir?: string;
  hasPersonaBody: boolean;
};

type ManagerRequest = {
  phase: "manager";
  caller: LaunchCaller;
  target: LaunchTarget;
  /** Runner values come from enrollment and the peer's ready flags. */
  capabilities: Capabilities;
  input: BindingIntent & {
    templateId?: string;
    initialFiles?: readonly unknown[];
  };
  hasIndependentBinding: boolean;
  hasPersonaBody: boolean;
};

const reasons = {
  taskProject: "Choose the task’s project for its runner session.",
  projectAndLocation: "Choose a project or a folder, not both.",
  missingLocation: "Body must include cwd as a string.",
  mcpTarget:
    "A child launch cannot select a checkout on another runner or outside the caller's project.",
  templateDirectory: "Project template directory cannot be overridden.",
  independentBinding: "Invalid independent runner checkout binding.",
  sharedBinding: "Invalid shared checkout binding.",
  reviewerPersona: "Missing reviewer persona.",
  childBinding: "Invalid child checkout binding.",
  repositoryPlacement: "Repository checkout requires a managed runner session.",
  invalidRepository: "Invalid runner repository.",
  runnerUnavailable: "The enrolled runner workspace is unavailable.",
  runnerStorage:
    "Runner launches require a standalone agent and runner-managed storage.",
  sessionFiles: "Update the runner to launch with startup files.",
  sharedWorktree:
    "Update the runner to launch an agent in an existing checkout.",
};

type Reason = keyof typeof reasons;
type Rejection = {
  ok: false;
  reason: Reason;
  message: string;
  statusCode: 400 | 409;
};
type Admission<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | Rejection;

function reject(
  reason: Reason,
  statusCode: Rejection["statusCode"] = 400,
  message = reasons[reason]
): Rejection {
  return { ok: false, reason, message, statusCode };
}

type ApiAdmission = Admission<{ projectId?: string }>;
type McpAdmission = Admission<{ cwd: string }>;
type SharedAdmission = Admission<{ owner: AgentRecord; parentId?: string }>;

type ManagerAdmission = Admission<{
  repository?: RepositoryTarget;
  useWorktree?: boolean;
}>;

/**
 * Check admission at the existing call sites, as task, template and checkout
 * facts become available. Keep validation order across the phases.
 */
export function admitLaunch(request: ApiRequest): ApiAdmission;
export function admitLaunch(request: McpRequest): McpAdmission;
export function admitLaunch(request: IndependentRequest): Admission;
export function admitLaunch(request: SharedRequest): SharedAdmission;
export function admitLaunch(request: ManagerRequest): ManagerAdmission;
export function admitLaunch(
  request:
    | ApiRequest
    | McpRequest
    | IndependentRequest
    | SharedRequest
    | ManagerRequest
):
  | ApiAdmission
  | McpAdmission
  | Admission
  | SharedAdmission
  | ManagerAdmission {
  switch (request.phase) {
    case "api": {
      const managed = request.target === "managedRepository";
      let { projectId } = request;
      const { cwd, taskProjectId } = request;
      if (request.caller === "task") {
        if (managed && projectId && projectId !== taskProjectId)
          return reject("taskProject");
        if (!projectId && (managed || !cwd)) projectId = taskProjectId;
      }
      if (projectId && cwd && !managed) return reject("projectAndLocation");
      if (!projectId && typeof cwd !== "string")
        return reject("missingLocation");
      return { ok: true, projectId };
    }
    case "mcpTarget":
    case "mcpTemplate": {
      // Child and independent MCP callers have the same scope today.
      const { sourceCwd, sourceWorkdir, sourceProjectId, template, cwd } =
        request;
      const runner = remotePlacement(sourceCwd);
      const requestedCwd = cwd ?? template?.directory;
      if (request.phase === "mcpTarget") {
        if (
          runner
            ? (cwd !== undefined && cwd !== sourceCwd) ||
              (template &&
                remotePlacement(template.directory) &&
                template.directory !== sourceCwd) ||
              (template?.projectId && template.projectId !== sourceProjectId)
            : remotePlacement(requestedCwd ?? "")
        )
          return reject("mcpTarget");
      } else if (
        !runner &&
        template?.projectId &&
        cwd &&
        cwd !== template.directory
      ) {
        return reject("templateDirectory");
      }
      return {
        ok: true,
        cwd: runner ? sourceCwd : (requestedCwd ?? sourceWorkdir),
      };
    }
    case "independentBinding": {
      const { input, owner, hasPersonaBody, borrowsCheckout } = request;
      if (
        !owner ||
        !remotePlacement(owner.cwd) ||
        input.cwd !== owner.cwd ||
        input.launchedByAgentId !== owner.id ||
        (input.parentAgentId && input.parentAgentId !== owner.id) ||
        (input.fullAccess && !owner.fullAccess) ||
        (input.persona && !hasPersonaBody) ||
        borrowsCheckout
      )
        return reject("independentBinding");
      return { ok: true };
    }
    case "sharedBinding": {
      const { input, owner, ownerWorkdir, hasPersonaBody } = request;
      // A child or reviewer borrows its parent's checkout. An independent
      // agent without its own worktree borrows its launcher's, as it runs in
      // the launcher's folder locally; it stays outside the parent lineage.
      if (
        !owner ||
        input.launchedByAgentId !== owner.id ||
        (!input.parentAgentId && input.role === "review") ||
        input.repository ||
        input.useWorktree ||
        (input.cwd !== owner.cwd && input.cwd !== ownerWorkdir) ||
        (input.projectId !== undefined && input.projectId !== owner.projectId)
      )
        return reject("sharedBinding");
      if (input.role === "review") {
        if (!input.persona) return reject("reviewerPersona");
      } else if (
        (input.parentAgentId !== undefined &&
          input.parentAgentId !== owner.id) ||
        !remotePlacement(owner.cwd) ||
        (input.fullAccess && !owner.fullAccess) ||
        (input.persona && !hasPersonaBody)
      ) {
        return reject("childBinding");
      }
      return { ok: true, owner, parentId: input.parentAgentId };
    }
    case "manager": {
      const {
        target,
        input,
        capabilities,
        hasIndependentBinding,
        hasPersonaBody,
      } = request;
      const borrowed = typeof target === "object";
      const workspace = borrowed ? target.borrowed : target;
      const managed = workspace === "managedRepository";
      let repository: RepositoryTarget | undefined;
      if (input.repository !== undefined) {
        if (!managed) return reject("repositoryPlacement");
        try {
          repository = parseRepositoryTarget(input.repository);
        } catch (error) {
          return reject("invalidRepository", 400, errorMessage(error));
        }
      }
      if (workspace === "folder")
        return { ok: true, useWorktree: input.useWorktree };
      if (!capabilities.available) return reject("runnerUnavailable", 409);
      if (
        (!borrowed && !hasIndependentBinding && input.parentAgentId) ||
        // A project template selects an existing configured workspace;
        // the manager verifies project membership after admission.
        (!managed &&
          (request.caller === "job" ||
            input.useWorktree ||
            Boolean(input.projectId) !== Boolean(input.templateId))) ||
        (input.persona &&
          !borrowed &&
          !hasPersonaBody &&
          !input.templateId &&
          request.caller !== "job")
      )
        return reject("runnerStorage");
      if (input.initialFiles?.length && !capabilities.sessionFiles)
        return reject("sessionFiles", 409);
      if (borrowed && !capabilities.sharedWorktree)
        return reject("sharedWorktree", 409);
      return {
        ok: true,
        repository,
        // A repository without an explicit checkout plan gets a worktree.
        useWorktree: repository
          ? !repository.checkout
          : input.useWorktree === true,
      };
    }
  }
}
