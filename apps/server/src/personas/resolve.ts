import {
  loadPersonaBySlug,
  loadPersonas,
  mergePersonasWithWorktreePrecedence,
  supportsPersonaType,
  type PersonaDefinition,
} from "./loader.js";
import {
  appendBuiltInPersonas,
  BUILT_IN_PERSONAS,
  getBuiltInPersona,
} from "./built-in.js";
import { resolveWorktreeRoot } from "../shared/git/git-context.js";
import { personaCatalog } from "./catalog.js";

export async function discoverPersonas(
  cwd: string,
  source: "catalog" | "workspace" = "workspace",
  waitForRefresh = false
) {
  const root = await resolveWorktreeRoot(cwd).catch(() => cwd);
  const catalog = await personaCatalog.get(root, waitForRefresh);
  const warnings = [...catalog.warnings];
  const local =
    source === "workspace" ? await loadPersonas(root, warnings) : [];
  return {
    ...catalog,
    warnings,
    personas: appendBuiltInPersonas(
      mergePersonasWithWorktreePrecedence({
        worktreePersonas: local,
        repoPersonas: catalog.personas,
      }),
      BUILT_IN_PERSONAS
    ),
  };
}

export async function resolveLaunchPersona(
  cwd: string,
  slug: string,
  type?: "task" | "review",
  source: "catalog" | "workspace" = "workspace"
): Promise<PersonaDefinition> {
  if (slug.includes("/") || slug.includes("\\") || slug.includes(".."))
    throw new Error("Invalid persona slug.");
  const root = await resolveWorktreeRoot(cwd).catch(() => cwd);
  // A malformed local override must fail explicitly, not fall back to a remote copy.
  let persona =
    source === "workspace" ? await loadPersonaBySlug(root, slug) : null;
  if (!persona) {
    const catalog = await personaCatalog.get(root, true);
    persona = catalog.personas.find((p) => p.slug === slug) ?? null;
    if (!persona && catalog.refreshing)
      throw new Error(
        "Persona catalog is still refreshing. Try again shortly."
      );
  }
  persona ??= getBuiltInPersona(slug);
  if (!persona) throw new Error(`Persona "${slug}" not found.`);
  if (type && !supportsPersonaType(persona, type))
    throw new Error(`Persona "${slug}" is not available for ${type} launches.`);
  if (!persona.body.trim())
    throw new Error(`Persona "${slug}" has no instructions.`);
  return persona;
}
