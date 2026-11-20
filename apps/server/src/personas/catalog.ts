import type { DefaultBranchFilesReply } from "@dispatch/runner-protocol";
import {
  DefaultBranchFiles,
  DEFAULT_BRANCH_REFRESH_MS,
} from "../agents/default-branch-files.js";
import { resolveRepoRoot } from "../shared/git/git-context.js";
import type { CommandRunner } from "../shared/lib/run-command.js";
import {
  loadCheckoutPersonas,
  loadPersonas,
  type PersonaDefinition,
} from "./loader.js";
import { PERSONA_DIRS } from "./paths.js";

export const PERSONA_REFRESH_MS = DEFAULT_BRANCH_REFRESH_MS;

export type PersonaCatalog = {
  personas: PersonaDefinition[];
  warnings: string[];
  refreshing: boolean;
  updatedAt: number | null;
};

export async function parseDefaultBranchPersonas(
  reply: DefaultBranchFilesReply
): Promise<PersonaCatalog> {
  const warnings = [...reply.warnings];
  if (reply.truncated)
    warnings.push("The default-branch file listing was incomplete.");
  const files = new Map(
    reply.files.map(({ path, content }) => [path, content])
  );
  const personas = await loadCheckoutPersonas(
    async (directory) =>
      reply.files
        .filter(
          ({ path }) => path.slice(0, path.lastIndexOf("/")) === directory
        )
        .map(({ path }) => path.slice(directory.length + 1)),
    async (path) => files.get(path) ?? null,
    warnings
  );
  return {
    personas,
    warnings,
    refreshing: reply.refreshing,
    updatedAt: reply.updatedAt,
  };
}

/** Catalog for launch configuration before a session exists. */
export class PersonaCatalogCache {
  private files: DefaultBranchFiles;

  constructor(run?: CommandRunner, now?: () => number) {
    this.files = new DefaultBranchFiles(run, now);
  }

  async get(cwd: string, waitForRefresh = false): Promise<PersonaCatalog> {
    const reply = await this.files.get(cwd, [...PERSONA_DIRS], waitForRefresh);
    if (reply.hasOrigin) return parseDefaultBranchPersonas(reply);
    const warnings: string[] = [];
    const root = await resolveRepoRoot(cwd).catch(() => cwd);
    return {
      personas: await loadPersonas(root, warnings),
      warnings,
      refreshing: false,
      updatedAt: null,
    };
  }
}

export const personaCatalog = new PersonaCatalogCache();
