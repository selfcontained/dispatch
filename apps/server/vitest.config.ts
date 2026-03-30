import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      // Legacy non-vitest test
      "test/stream-process.test.ts",
    ],
  },
});
