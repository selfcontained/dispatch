import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  decideStartupMode,
  loadInstalledEnv,
} from "../src/windows-setup/startup-mode.js";

describe("loadInstalledEnv", () => {
  it("reads .env beside the executable when the cwd has none", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-installed-"));
    try {
      writeFileSync(
        path.join(dir, ".env"),
        "DATABASE_URL=postgres://d:p@h/d\nDISPATCH_PORT=6767\n"
      );
      const env: NodeJS.ProcessEnv = {};
      expect(
        loadInstalledEnv({ execPath: path.join(dir, "dispatch.exe"), env })
      ).toBe(true);
      expect(env.DATABASE_URL).toBe("postgres://d:p@h/d");
      expect(env.DISPATCH_PORT).toBe("6767");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overrides values already in the environment", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-installed-"));
    try {
      writeFileSync(path.join(dir, ".env"), "DISPATCH_PORT=6767\n");
      const env: NodeJS.ProcessEnv = { DISPATCH_PORT: "7000" };
      loadInstalledEnv({ execPath: path.join(dir, "dispatch.exe"), env });
      expect(env.DISPATCH_PORT).toBe("7000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when there is no .env beside the executable", () => {
    expect(
      loadInstalledEnv({ execPath: "/nonexistent/dir/dispatch.exe", env: {} })
    ).toBe(false);
  });
});

describe("decideStartupMode", () => {
  const base = {
    platform: "win32" as const,
    env: {} as NodeJS.ProcessEnv,
    argv: ["bun", "main.ts"],
  };

  it("enters setup on Windows with no DATABASE_URL", () => {
    expect(decideStartupMode(base)).toBe("setup");
  });

  it("serves on Windows when DATABASE_URL is set", () => {
    expect(
      decideStartupMode({ ...base, env: { DATABASE_URL: "postgres://x" } })
    ).toBe("serve");
  });

  it("serves on macOS and Linux without DATABASE_URL", () => {
    expect(decideStartupMode({ ...base, platform: "darwin" })).toBe("serve");
    expect(decideStartupMode({ ...base, platform: "linux" })).toBe("serve");
  });

  it("leaves subcommands alone", () => {
    expect(
      decideStartupMode({ ...base, argv: [...base.argv, "agent-host"] })
    ).toBe("serve");
  });

  it("forces setup with DISPATCH_FORCE_SETUP_MODE=1 anywhere", () => {
    expect(
      decideStartupMode({
        ...base,
        platform: "darwin",
        env: { DISPATCH_FORCE_SETUP_MODE: "1" },
      })
    ).toBe("setup");
  });
});
