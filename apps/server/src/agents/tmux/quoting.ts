/**
 * Wrap a value in single quotes for use as a Bash argument, escaping any
 * embedded single quotes via the `'\''` idiom. Use this when the value will
 * be passed to a tmux/bash command as a standalone argument.
 */
export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Escape embedded single quotes only — no outer quotes. Use this when the
 * value will be interpolated *inside* an existing single-quoted Bash string
 * (where `shellEscape` would over-quote and break the surrounding string).
 */
export function shellQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}
