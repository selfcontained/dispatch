type SelfImprovementSource =
  | { kind: "template"; templateId: string }
  | { kind: "job"; name: string; directory: string };

/**
 * Runtime-only guidance for launch configurations that opt into self-improvement.
 * It is deliberately not persisted with the source prompt, so it cannot compound
 * across runs.
 */
export function buildSelfImprovementGuidance(
  source: SelfImprovementSource
): string {
  const updateInstruction =
    source.kind === "template"
      ? `use update_template with templateId "${source.templateId}" and the complete revised prompt.`
      : `use update_job with name "${source.name}", directory "${source.directory}", and the complete revised prompt.`;

  return [
    "\nSelf-improvement:",
    "Before you finish, briefly reflect on whether the saved launch prompt could make the next run more effective.",
    "Only if you identify a clear, durable improvement, update the source prompt directly: " +
      updateInstruction,
    "Preserve the prompt's intent and task-specific details. Do not change it for a one-off preference, and do not add this self-improvement guidance to the saved prompt.",
  ].join("\n");
}
