import path from "node:path";
import { writeFile } from "node:fs/promises";
import { MAX_PERSONA_PROMPT_BYTES } from "../../personas/loader.js";

/** Persisted launch metadata only; never forwarded to an engine CLI. */
export const PERSONA_CONTEXT_ARG = "--dispatch-persona-context";

export function extractPersonaContext(args: readonly string[]): string | null {
  const index = args.indexOf(PERSONA_CONTEXT_ARG);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

/** Keep the snapshot in the private host directory so restarts can recover it. */
export async function preparePersonaContext(
  stateDir: string,
  context: string | null | undefined
): Promise<string | null> {
  if (!context) return null;
  if (Buffer.byteLength(context, "utf8") <= MAX_PERSONA_PROMPT_BYTES)
    return context;
  const file = path.join(stateDir, "persona-context.md");
  await writeFile(file, context, { mode: 0o600 });
  return `The complete persona instructions, ownership scope, and briefing exceed the inline message budget. Nothing has been trimmed. Before beginning the task, read the entire UTF-8 launch context file at ${JSON.stringify(file)}. If your file tool limits output, read it in chunks until you reach the end. If you cannot read it, report the problem to the launching agent instead of reviewing with incomplete instructions.`;
}

export function firstPromptContext(
  delivery: "system_prompt" | "first_prompt" | "instructions_file",
  systemPrompt: string | null,
  personaContext: string | null | undefined
): string | null {
  return (
    [delivery === "first_prompt" ? systemPrompt : null, personaContext]
      .filter(Boolean)
      .join("\n\n") || null
  );
}
