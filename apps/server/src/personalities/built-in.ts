import type { Personality } from "../db/personalities.js";

/**
 * Personalities Dispatch ships itself, mirroring `personas/built-in.ts`: they
 * exist before anyone writes one, and a stored row with the same id replaces
 * the built-in rather than sitting beside it.
 *
 * That override is narrower than the persona one. `createPersonality` assigns
 * `randomUUID()`, so a user cannot create a row that collides with a slug —
 * the path is reserved for rows seeded or imported under a known id.
 */

/**
 * The ladder is adapted from `DietrichGebert/ponytail` (MIT). It is adapted
 * rather than installed because ponytail ships as per-agent plugins and rule
 * files, which would reach only the plugin-capable agent types instead of
 * every type `buildLaunchGuidance` already covers.
 *
 * The carve-out is load-bearing. Ponytail states it, and it is what makes the
 * ladder safe: without it a rule about writing less code becomes a rule about
 * skipping validation. It is not what gets cut to fit `PROMPT_MAX`.
 */
const ECONOMY_PROMPT = `Reach for the smallest thing that works.

Before writing code, stop at the first rung that holds:
1. Does this need to exist at all?
2. Is it already in this codebase?
3. Does the standard library do it?
4. Is it a native platform feature?
5. Is it in a dependency already installed here?
6. Is it one line?
7. Only then, the minimum that actually works.

Never on the chopping block: validation at a trust boundary, data-loss
handling, security, and accessibility. Cutting those is not economy, it is a
defect.

Keep prose short. Answer in the fewest words that are still complete, and skip
preamble, restatement, and closing summaries unless you are asked for one.`;

/** Built-ins predate any row, so they carry a fixed timestamp rather than a lie. */
const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const BUILT_IN_PERSONALITIES: readonly Personality[] = [
  {
    id: "economy",
    name: "Economy",
    prompt: ECONOMY_PROMPT,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
  },
];

export function getBuiltInPersonality(id: string): Personality | null {
  return BUILT_IN_PERSONALITIES.find((p) => p.id === id) ?? null;
}

export function isBuiltInPersonalityId(id: string): boolean {
  return BUILT_IN_PERSONALITIES.some((p) => p.id === id);
}
