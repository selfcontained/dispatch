import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSetupEnv } from "../src/windows-setup/env-file.js";
import { runSetupMode } from "../src/windows-setup/run-setup-mode.js";

describe("runSetupMode", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("opens the browser, waits for install, and exports the env", async () => {
    process.env.DISPATCH_SETUP_INSTALL_DIR = "/tmp/dispatch-install";
    const env = buildSetupEnv({
      databaseUrl: "postgres://dispatch:pw@127.0.0.1:5432/dispatch",
      port: 6767,
      installDir: "/tmp/dispatch-install",
    });
    const log: string[] = [];
    const events: string[] = [];
    const close = vi.fn(async () => {
      events.push("close");
    });
    const startSetupServer = vi.fn(async () => ({
      url: "http://127.0.0.1:4321/setup",
      installed: Promise.resolve(env),
      close,
    }));
    const openBrowser = vi.fn(async (url: string) => {
      events.push(`open ${url}`);
      events.push(`logged-before-open ${log.length}`);
    });

    const result = await runSetupMode({
      startSetupServer: startSetupServer as never,
      openBrowser,
      log: (line) => log.push(line),
      closeDelayMs: 0,
    });

    expect(result).toEqual(env);
    expect(log).toEqual([
      "Dispatch setup — opening http://127.0.0.1:4321/setup in your browser",
      "Dispatch is running at http://127.0.0.1:6767",
    ]);
    expect(events[0]).toBe("open http://127.0.0.1:4321/setup");
    expect(events[1]).toBe("logged-before-open 1");
    expect(process.env.DATABASE_URL).toBe(env.DATABASE_URL);
    expect(process.env.DISPATCH_UPDATE_OWNER).toBe("windows-tray");
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });
});
