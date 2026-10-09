/**
 * Personas and the owners map live under the tool-neutral `.agents/` folder.
 * The original `.dispatch/` locations are still read so existing repos keep
 * working; on a slug conflict the `.agents/` file wins.
 */
export const PERSONAS_DIR = ".agents/personas";
export const LEGACY_PERSONAS_DIR = ".dispatch/personas";
/** Read in precedence order. */
export const PERSONA_DIRS = [PERSONAS_DIR, LEGACY_PERSONAS_DIR] as const;

export const OWNERS_PATH = ".agents/owners.json";
export const LEGACY_OWNERS_PATH = ".dispatch/codeowners.json";
