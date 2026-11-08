import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __DISPATCH_VERSION__: JSON.stringify("0.0.0-test"),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Local worktrees and self-hosted CI share a machine. Bound each run's
    // worker multiplier and each fork's V8 old-space without capping tsc/build.
    // This is not a native-memory or host-wide RSS limit.
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
    fileParallelism: true,
    poolOptions: {
      forks: {
        execArgv: ["--max-old-space-size=768"],
      },
    },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
    },
  },
});
