import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The Codex token harvester resolves its rollout directory from `CODEX_HOME`,
// falling back to the host's real `~/.codex` (see src/agents/codex-sessions.ts).
// Any test that harvests a codex agent — including the fire-and-forget harvest
// `stopAgent` kicks off, which no per-test override can wrap — then recursively
// walks that directory and reads the head of every rollout file. On a machine
// that actually uses Codex that is gigabytes of I/O per run, and the self-hosted
// CI runner is such a machine. Point the whole suite at an empty directory so no
// test ever reads the host's CLI history.
//
// `mkdtempSync` rather than a fixed name: it creates a fresh 0700 directory with
// a random suffix, so it can never reuse a stale tree, adopt a planted
// `sessions` directory, or follow a pre-existing symlink the way
// `mkdirSync(fixedName, { recursive: true })` silently would. Removed on exit;
// concurrent runs each get their own.
const codexHome = mkdtempSync(
  path.join(os.tmpdir(), "dispatch-server-vitest-codex-")
);
process.on("exit", () => {
  rmSync(codexHome, { recursive: true, force: true });
});

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      CODEX_HOME: codexHome,
    },
    include: ["test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      // Legacy non-vitest test
      "test/stream-process.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
    },
  },
});
