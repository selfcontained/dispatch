import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

// Remote runner acceptance: serial (one shared fleet of Docker runners),
// longer timeouts. Launched by scripts/e2e-remote-runners.sh, which exports
// REMOTE_E2E_STATE and the enrolled-mode DISPATCH_RUNNER_* service settings.
export default defineConfig({
  ...base,
  testDir: ".",
  testIgnore: [],
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 180_000,
  retries: 0,
  failOnFlakyTests: false,
  webServer:
    base.webServer &&
    ({
      ...(base.webServer as object),
      env: {
        ...((base.webServer as { env?: Record<string, string> }).env ?? {}),
        DISPATCH_RUNNER_HOST: process.env.DISPATCH_RUNNER_HOST ?? "",
        DISPATCH_RUNNER_PORT: process.env.DISPATCH_RUNNER_PORT ?? "",
        DISPATCH_RUNNER_ENDPOINT_HOST:
          process.env.DISPATCH_RUNNER_ENDPOINT_HOST ?? "",
      },
    } as never),
});
