/**
 * The text that leads the first prompt after a launch or resume: the system
 * prompt when the engine takes it no other way, then the caller's first
 * text. The host does not know what either says.
 */
export function firstPromptContext(
  delivery: "system_prompt" | "first_prompt" | "instructions_file",
  systemPrompt: string | null,
  promptContext: string | null | undefined
): string | null {
  return (
    [delivery === "first_prompt" ? systemPrompt : null, promptContext]
      .filter(Boolean)
      .join("\n\n") || null
  );
}
