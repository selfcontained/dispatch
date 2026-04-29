/**
 * Helpers for converting between agent IDs and tmux session names.
 *
 * Session names follow the shape `<prefix>_<agentId>[_<slug>]`, e.g.
 * `dispatch_agt_abc123def456_my-task` or `dispatch_dev_agt_abc123def456`.
 * The `<slug>` is a sanitized form of the agent's display name, included
 * for human readability in `tmux ls` output.
 */

const AGENT_ID_PATTERN = /(agt_[a-f0-9]{12})/;

/**
 * Extract the agent ID embedded in a session name. Falls back to stripping
 * the leading `<prefix>_` segment if no canonical `agt_…` ID is present
 * (legacy sessions).
 */
export function agentIdFromSessionName(sessionName: string): string {
  const match = sessionName.match(AGENT_ID_PATTERN);
  return match?.[1] ?? sessionName.replace(/^[^_]*_/, "");
}

/**
 * Build a tmux session name from `(prefix, agentId, agentName?)`. The
 * optional `agentName` is slug-sanitized: lowercased, non-alphanumerics
 * collapsed to hyphens, edge hyphens trimmed, truncated to 30 chars.
 *
 * tmux disallows colons and periods in session names, so the slug rules
 * are conservative — alphanumerics + hyphens only.
 */
export function toSessionName(
  prefix: string,
  agentId: string,
  agentName?: string
): string {
  if (!agentName) {
    return `${prefix}_${agentId}`;
  }
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `${prefix}_${agentId}_${slug}`;
}

/**
 * Decide whether the launch guidance should ask the agent to rename its
 * session. Returns `true` only when the existing name is a default
 * placeholder — never when the user (or a persona) chose a meaningful name.
 *
 * - Persona agents: never suggest (the persona name is the meaningful one).
 * - Job runs: suggest only when the name still matches the auto-generated
 *   `job-…-<jobRunIdPrefix>` shape.
 * - Standard agents: suggest only when the name still matches the
 *   `agent-<last6>` placeholder generated when no name is supplied.
 */
export function shouldSuggestSessionRename(
  agentName: string | null | undefined,
  agentId: string,
  opts: { persona?: string | null; jobRunId?: string }
): boolean {
  if (opts.persona) {
    return false;
  }

  const trimmed = agentName?.trim();
  if (opts.jobRunId) {
    const jobNameSuffix = `-${opts.jobRunId.slice(0, 8)}`;
    return (
      !!trimmed && trimmed.startsWith("job-") && trimmed.endsWith(jobNameSuffix)
    );
  }

  return trimmed === `agent-${agentId.slice(-6)}`;
}
