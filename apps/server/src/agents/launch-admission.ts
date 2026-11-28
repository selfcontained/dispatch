import { errorMessage } from "../shared/lib/error-message.js";
import {
  parseRepositoryTarget,
  type RepositoryTarget,
} from "./remote/repository.js";
import type { AgentRecord, AgentRole } from "./types.js";

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
  projectTarget: boolean;
  cwd: unknown;
  projectId?: string;
  taskProjectId?: string;
};

type McpRequest = {
  phase: "mcpTarget" | "mcpTemplate";
  caller: "mcpChild" | "mcpIndependent";
  /** The caller's current folder, as a launch names it. */
  sourceWorkdir: string;
  /** The caller's current folder as the agent reports it, if it moved. */
  sourcePath?: string | null;
  cwd?: string;
  template?: { directory: string; projectId?: string | null } | null;
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
  remote: boolean;
  /** Runner values come from enrollment and the peer's ready flags. */
  available: boolean;
  input: BindingIntent & {
    initialFiles?: readonly unknown[];
  };
};

const reasons = {
  projectAndLocation: "Choose a project or a folder, not both.",
  missingLocation: "Body must include cwd as a string.",
  relativeLocation: "Working directory must be an absolute path.",
  templateDirectory: "Project template directory cannot be overridden.",
  sharedBinding: "Invalid shared checkout binding.",
  reviewerPersona: "Missing reviewer persona.",
  childBinding: "Invalid child checkout binding.",
  invalidRepository: "Invalid runner repository.",
  runnerUnavailable: "The enrolled runner workspace is unavailable.",
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

/** Main's `validateWorkingDirectory`: absolute, or under the home directory. */
function launchPath(cwd: string) {
  return cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("/");
}

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
export function admitLaunch(request: SharedRequest): SharedAdmission;
export function admitLaunch(request: ManagerRequest): ManagerAdmission;
export function admitLaunch(
  request: ApiRequest | McpRequest | SharedRequest | ManagerRequest
):
  | ApiAdmission
  | McpAdmission
  | Admission
  | SharedAdmission
  | ManagerAdmission {
  switch (request.phase) {
    case "api": {
      const { projectTarget } = request;
      let { projectId } = request;
      const { cwd, taskProjectId } = request;
      if (request.caller === "task" && !projectId && (projectTarget || !cwd))
        projectId = taskProjectId;
      if (projectId && cwd && !projectTarget)
        return reject("projectAndLocation");
      if (!projectId && typeof cwd !== "string")
        return reject("missingLocation");
      return { ok: true, projectId };
    }
    case "mcpTarget":
    case "mcpTemplate": {
      // A folder is a path on the caller's machine, for every caller. The
      // caller's own current folder is its session's (D7); another folder
      // is one its account can use there, as a local caller's is (D7).
      const { sourceWorkdir, sourcePath, template, cwd } = request;
      const own =
        cwd === undefined
          ? !template
          : cwd === sourceWorkdir || (!!sourcePath && cwd === sourcePath);
      if (request.phase === "mcpTemplate") {
        if (template?.projectId && cwd && cwd !== template.directory)
          return reject("templateDirectory");
        // Main's rule: a folder, never a runner address.
        if (cwd !== undefined && !own && !launchPath(cwd))
          return reject("relativeLocation");
      }
      return {
        ok: true,
        cwd: own ? sourceWorkdir : (cwd ?? template!.directory),
      };
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
      const review = input.role === "review";
      if (
        review
          ? !input.persona
          : (input.parentAgentId !== undefined &&
              input.parentAgentId !== owner.id) ||
            (input.fullAccess && !owner.fullAccess) ||
            (input.persona && !hasPersonaBody)
      )
        return reject(review ? "reviewerPersona" : "childBinding");
      return { ok: true, owner, parentId: input.parentAgentId };
    }
    case "manager": {
      const { remote, input, available } = request;
      if (!remote) return { ok: true, useWorktree: input.useWorktree };
      let repository: RepositoryTarget | undefined;
      if (input.repository !== undefined) {
        try {
          repository = parseRepositoryTarget(input.repository);
        } catch (error) {
          return reject("invalidRepository", 400, errorMessage(error));
        }
      }
      if (!available) return reject("runnerUnavailable", 409);
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
