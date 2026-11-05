import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Deliberately explicit: admitting a test here promises no DB, subprocesses,
// network or host state. The aggregate suite still covers all other tests.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "test/error-message.test.ts",
      "test/format-bytes.test.ts",
      "test/focus-tracker.test.ts",
      "test/file-type.test.ts",
      "test/resolve-tilde.test.ts",
      "test/worktree-slug.test.ts",
      "test/agent-strings.test.ts",
      "test/loop-text.test.ts",
      "test/template-args.test.ts",
      "test/template-arg-parser.test.ts",
      "test/mentions.test.ts",
      "test/extract-hunk.test.ts",
      "test/diff-file-rules.test.ts",
      "test/cron.test.ts",
      "test/jobs/cron.test.ts",
    ],
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});
