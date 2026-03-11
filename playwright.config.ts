import { defineConfig } from "@playwright/test";

const devPort = process.env.E2E_PORT ?? "8788";
const baseURL = `http://127.0.0.1:${devPort}`;

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
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build:web && DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:5432/dispatch_dev DISPATCH_PORT=${devPort} MEDIA_ROOT=$HOME/.dispatch/media-dev npm run dev`,
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
