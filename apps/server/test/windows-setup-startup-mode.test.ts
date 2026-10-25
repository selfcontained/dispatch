import { describe, expect, it } from "vitest";

import { decideStartupMode } from "../src/windows-setup/startup-mode.js";

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
