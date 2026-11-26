import type { PersonaDefinition } from "../../src/personas/loader.js";
/** Test-only wiring for native folder loader construction without an app registry. */
import {
  loadPersonas as load,
  loadPersonaBySlug as bySlug,
  mergePersonasWithWorktreePrecedence,
} from "../../src/personas/loader.js";
import {
  appendBuiltInPersonas,
  BUILT_IN_PERSONAS,
} from "../../src/personas/built-in.js";
export * from "../../src/personas/loader.js";
export function loadPersonas(root: string, warnings: string[] = []) {
  return load(root, warnings, {});
}
export function loadPersonaBySlug(root: string, slug: string) {
  return bySlug(root, slug, {});
}
export async function loadPersonasFromRoots(input: {
  worktreeRoot?: string | null;
  repoRoot?: string | null;
  warnings?: string[];
}): Promise<PersonaDefinition[]> {
  const worktreeRoot = input.worktreeRoot ?? null;
  const repoRoot = input.repoRoot ?? null;

  const worktreePersonas = worktreeRoot
    ? await loadPersonas(worktreeRoot, input.warnings)
    : [];
  const repoPersonas =
    repoRoot && repoRoot !== worktreeRoot
      ? await loadPersonas(repoRoot, input.warnings)
      : [];

  return appendBuiltInPersonas(
    mergePersonasWithWorktreePrecedence({
      worktreePersonas,
      repoPersonas,
    }),
    BUILT_IN_PERSONAS
  );
}
