import path from "node:path";

/**
 * A package manager's bin directory (`…/node_modules/.bin`). A CLI there is
 * some project's build dependency — codex-acp pulls in its own
 * @openai/codex — never the engine a person installed and signed into.
 * `pnpm run`, `npm run` and `bun run` put these at the front of PATH, so a
 * server started through one (every dev stack) would otherwise drive the
 * dependency's older CLI and learn its model list instead of the real one.
 */
export function isPackageBinDir(dir: string): boolean {
  const normalized = path.normalize(dir).replace(/[\\/]+$/, "");
  return (
    path.basename(normalized) === ".bin" &&
    path.basename(path.dirname(normalized)) === "node_modules"
  );
}
