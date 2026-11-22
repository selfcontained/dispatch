import type { DefaultBranchFilesReply } from "@dispatch/runner-protocol";
import {
  DefaultBranchFiles,
  DEFAULT_BRANCH_REFRESH_MS,
} from "../agents/default-branch-files.js";
import { resolveRepoRoot } from "../shared/git/git-context.js";
import type { CommandRunner } from "../shared/lib/run-command.js";
import {
  loadPersonas,
  toPersonaDefinition,
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
  const personas: PersonaDefinition[] = [];
  const seen = new Set<string>();
  for (const { path, content } of reply.files) {
    const slug = path.slice(path.lastIndexOf("/") + 1, -3);
    if (!path.endsWith(".md") || seen.has(slug)) continue;
    seen.add(slug);
    try {
      personas.push(toPersonaDefinition(slug, content));
    } catch {
      warnings.push(
        `Could not load persona ${path}: invalid persona definition.`
      );
    }
  }
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
