/**
 * Bullet-list parsing for the job loop fields (done-when criteria, recovery
 * steps), shared by the MCP job tools (apps/server/src/shared/mcp/crud-tools.ts)
 * and the jobs form in the web client, which re-exports it across the workspace
 * boundary (see apps/web/src/components/app/jobs-continuation-fields.tsx). Keep
 * it dependency-free: no node imports, no browser globals.
 *
 * Only the parse is shared. Each caller keeps its own policy for missing and
 * empty input on purpose: the MCP tools return [] for a non-string value and
 * pass `undefined` through untouched, while the form substitutes a single blank
 * row so there is always something to type into.
 */
export function parseLoopItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:[-*+] |\d+[.)] )/, "").trim());
}
