import { defineConfig } from "@playwright/test";

// Allow self-signed certs when running e2e against a TLS-enabled dev server.
// e2e-isolated.sh unsets TLS_CERT so this only fires for manual TLS test runs.
if (process.env.TLS_CERT) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const devPort = process.env.E2E_PORT ?? "8788";
const protocol = process.env.TLS_CERT ? "https" : "http";
const baseURL = `${protocol}://127.0.0.1:${devPort}`;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://dispatch:dispatch@127.0.0.1:5433/dispatch_dev";
const mediaRoot =
  process.env.MEDIA_ROOT ?? `${process.env.HOME}/.dispatch/media-dev`;
const agentRuntime =
  process.env.DISPATCH_AGENT_RUNTIME === "tmux" ? "tmux" : "inert";

// Tests that mutate global settings, create agents via UI, or have explicit
// serial constraints. These run after the parallel suite with a single worker.
const serialTests = [
  "e2e/settings.spec.ts",
  "e2e/jobs-api.spec.ts",
  "e2e/agent-crud.spec.ts",
  "e2e/terminal-live.spec.ts",
  "e2e/persona-recheck-ui.spec.ts",
  "e2e/mobile-layout.spec.ts",
  "e2e/media-sidebar.spec.ts",
];

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    extraHTTPHeaders: {},
    // Escape hatch for machines without Playwright's downloaded browsers
    // (e.g. a Homebrew Chromium install).
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          },
        }
      : {}),
  },
  webServer: {
    command: process.env.E2E_SKIP_WEB_BUILD
      ? "pnpm run dev"
      : "pnpm run build:web && pnpm run dev",
    env: {
      DATABASE_URL: databaseUrl,
      DISPATCH_PORT: devPort,
      MEDIA_ROOT: mediaRoot,
      DISPATCH_AGENT_RUNTIME: agentRuntime,
    },
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "parallel",
      testIgnore: serialTests,
      fullyParallel: false,
      workers: 4,
    },
    {
      name: "serial",
      testMatch: serialTests,
      fullyParallel: false,
      workers: 1,
      dependencies: ["parallel"],
    },
  ],
});
