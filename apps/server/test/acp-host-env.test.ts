import { describe, expect, it } from "vitest";

import { hostProcessEnv } from "../src/agents/acp/runtime.js";

describe("ACP host environment", () => {
  it("passes the fake adapter command while withholding server settings and credentials", () => {
    expect(
      hostProcessEnv({
        PATH: "/usr/bin",
        DISPATCH_ACP_ADAPTER_COMMAND: '["/tmp/fake-acp-agent"]',
        DISPATCH_AGENT_HOST_COMMAND: '["/tmp/host"]',
        DISPATCH_FILES_ROOT: "/tmp/dispatch-files",
        DATABASE_URL: "postgres://secret",
        ANTHROPIC_API_KEY: "secret",
      })
    ).toEqual({
      PATH: "/usr/bin",
      DISPATCH_ACP_ADAPTER_COMMAND: '["/tmp/fake-acp-agent"]',
    });
  });
});
