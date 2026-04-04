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
  "postgres://dispatch:dispatch@127.0.0.1:5432/dispatch_dev";
const mediaRoot =
  process.env.MEDIA_ROOT ?? `${process.env.HOME}/.dispatch/media-dev`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    extraHTTPHeaders: {},
  },
  webServer: {
    command: process.env.E2E_SKIP_WEB_BUILD
      ? "pnpm run dev"
      : "pnpm run build:web && pnpm run dev",
    env: {
      DATABASE_URL: databaseUrl,
      DISPATCH_PORT: devPort,
      MEDIA_ROOT: mediaRoot,
      DISPATCH_AGENT_RUNTIME: "inert",
    },
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
