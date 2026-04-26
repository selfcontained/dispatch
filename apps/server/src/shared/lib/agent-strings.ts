/**
 * Sanitization for arbitrary strings posted by a launched agent
 * (assisted-update notes, future per-job-nonce flows, etc.) before they
 * reach disk, SSE replay, or operator-visible log lines. One rule, one
 * place — every consumer inherits the same guarantees.
 */

export const MAX_NOTE_BYTES = 4096;

/**
 * Strip newlines (so an embedded "\n==>" can't synthesize fake adjacent
 * log lines in the operator UI) and cap to MAX_NOTE_BYTES (so a
 * misbehaving agent can't bloat the on-disk state file or every snapshot
 * reconnect). Returns undefined when the input is undefined so callers
 * can chain `if (sanitized) ...` without an extra null guard.
 */
export function sanitizeAgentString(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const stripped = s.replace(/[\r\n]+/g, " ");
  return stripped.length > MAX_NOTE_BYTES
    ? stripped.slice(0, MAX_NOTE_BYTES)
    : stripped;
}
