/** Persisted launch metadata only; never forwarded to an engine CLI. */
export const PERSONA_CONTEXT_ARG = "--dispatch-persona-context";

export function extractPersonaContext(args: readonly string[]): string | null {
  const index = args.indexOf(PERSONA_CONTEXT_ARG);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}
