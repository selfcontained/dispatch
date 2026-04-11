import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dispatch/shared": path.resolve(__dirname, "../../packages/shared/dist"),
    },
  },
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
