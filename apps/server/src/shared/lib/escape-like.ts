/** Escape `%`, `_`, and `\` for safe use inside a SQL LIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
