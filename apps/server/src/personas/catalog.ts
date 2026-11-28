import path from "node:path";
import { displayPath, pathFromWire } from "@dispatch/runner-protocol/contract";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../runners/directory.js";
import { controllerPlacement } from "../runners/placement.js";
import type { DefaultBranchFilesReply } from "@dispatch/runner-protocol";
import {
  loadPersonas,
  toPersonaDefinition,
  type PersonaDefinition,
} from "./loader.js";
import { PERSONA_DIRS } from "./paths.js";

export const PERSONA_REFRESH_MS = 5 * 60_000;

export type PersonaCatalog = {
  personas: PersonaDefinition[];
  warnings: string[];
  refreshing: boolean;
  updatedAt: number | null;
};

function diagnosticText(
  diagnostic: NonNullable<DefaultBranchFilesReply["diagnostics"]>[number]
) {
  switch (diagnostic.code) {
    case "unsupported":
      return `Could not load persona ${diagnostic.path}: unsupported file or larger than 256 KiB.`;
    case "unreadable":
      return `Could not load persona ${diagnostic.path}: invalid persona definition.`;
    case "limit":
      return "Persona catalog exceeds the 100-file or 4 MiB limit.";
    case "cache":
      return "Could not store the persona catalog. Check repository cache permissions.";
    case "refresh":
      return "Could not refresh personas from origin. Using cached definitions; retry is delayed automatically.";
    case "incomplete":
      return "The default-branch file listing was incomplete.";
  }
}

export async function parseDefaultBranchPersonas(
  reply: DefaultBranchFilesReply
): Promise<PersonaCatalog> {
  const warnings = [...reply.warnings];
  const personas: PersonaDefinition[] = [];
  const seen = new Set<string>();
  const diagnostics = reply.diagnostics ?? [];
  let next = 0;
  for (let index = 0; index <= reply.files.length; index++) {
    while (next < diagnostics.length && diagnostics[next]!.fileIndex === index)
      warnings.push(diagnosticText(diagnostics[next++]!));
    const file = reply.files[index];
    if (!file) break;
    const { path, content } = file;
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
  async get(
    cwd: string,
    waitForRefresh: boolean,
    runners: CheckoutCommandRunners
  ): Promise<PersonaCatalog> {
    const runner = runnerDirectory(runners).for(controllerPlacement);
    const target = { path: pathFromWire(path.resolve(cwd)) };
    const files = await runner.call("checkout.defaultFiles", {
      target,
      dirs: [...PERSONA_DIRS],
      wait: waitForRefresh,
    });
    const reply: DefaultBranchFilesReply = {
      kind: "defaultBranchFiles",
      ...files,
    };
    if (reply.hasOrigin) return parseDefaultBranchPersonas(reply);
    const warnings: string[] = [];
    const root = await runner
      .call("git.roots", { target })
      .then((roots) =>
        roots.repositoryRoot ? displayPath(roots.repositoryRoot) : cwd
      )
      .catch(() => cwd);
    return {
      personas: await loadPersonas(root, warnings, runners),
      warnings,
      refreshing: false,
      updatedAt: null,
    };
  }
}

export const personaCatalog = new PersonaCatalogCache();
