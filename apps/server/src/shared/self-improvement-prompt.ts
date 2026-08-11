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
    "Only if you identify a clear, durable improvement, adjust the source prompt directly: " +
      updateInstruction,
    "Default to a small, targeted change — adding, removing, or reworking a line or two within the existing structure, leaving the rest as-is — rather than restructuring or rewriting it. A broad change should be rare; if you're considering one, flag it for the user to review instead of applying it yourself.",
    "Keep the prompt's overall intent and task-specific details intact. Do not change it for a one-off preference, and do not add this self-improvement guidance to the saved prompt.",
  ].join("\n");
}
