import {
  loadPersonaBySlug,
  supportsPersonaType,
  type PersonaDefinition,
} from "./loader.js";
import { getBuiltInPersona } from "./built-in.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";

export async function resolveLaunchPersona(
  cwd: string,
  slug: string,
  type?: "task" | "review"
): Promise<PersonaDefinition> {
  const worktreeRoot = await resolveWorktreeRoot(cwd).catch(() => null);
  const repoRoot = await resolveRepoRoot(cwd).catch(() => null);
  let persona = await loadPersonaBySlug(worktreeRoot ?? cwd, slug);
  if (!persona && repoRoot && repoRoot !== worktreeRoot)
    persona = await loadPersonaBySlug(repoRoot, slug);
  persona ??= getBuiltInPersona(slug);
  if (!persona) throw new Error(`Persona "${slug}" not found.`);
  if (type && !supportsPersonaType(persona, type))
    throw new Error(`Persona "${slug}" is not available for ${type} launches.`);
  if (!persona.body.trim())
    throw new Error(`Persona "${slug}" has no instructions.`);
  return persona;
}
