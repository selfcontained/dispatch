import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { registerPluginRoutes } from "../src/routes/plugin.js";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock("../src/agent-type-settings.js", () => ({
  getEnabledAgentTypes: mocks.enabled,
}));
vi.mock("../src/shared/plugin-status.js", async (original) => ({
  ...(await original<typeof import("../src/shared/plugin-status.js")>()),
  createPluginStatusChecker: () => ({
    install: mocks.install,
    update: mocks.update,
    getStatus: mocks.getStatus,
  }),
}));
afterEach(() => vi.resetAllMocks());
async function request(body: unknown) {
  const app = Fastify();
  try {
    await registerPluginRoutes(app, {
      pool: {} as Pool,
      config: {} as AppConfig,
      appLog: app.log,
    });
    return await app.inject({
      method: "POST",
      url: "/api/v1/plugin/install",
      payload: body as Record<string, unknown>,
    });
  } finally {
    await app.close();
  }
}
describe("plugin install route", () => {
  it("dispatches installation and returns verified status", async () => {
    mocks.enabled.mockResolvedValue(["claude", "codex"]);
    const status = {
      agentType: "claude",
      installed: true,
      enabled: true,
      currentVersion: "0.5.0",
      latestVersion: "0.5.0",
      updateAvailable: false,
    };
    mocks.install.mockResolvedValue({ status, error: null });
    const response = await request({ agentType: "claude" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status });
    expect(mocks.install).toHaveBeenCalledWith("claude");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([{ agentType: "opencode" }, {}])(
    "rejects invalid install targets %j",
    async (body) => {
      expect((await request(body)).statusCode).toBe(400);
      expect(mocks.install).not.toHaveBeenCalled();
    }
  );
  it("rejects a disabled agent type before installation", async () => {
    mocks.enabled.mockResolvedValue(["codex"]);
    expect((await request({ agentType: "claude" })).statusCode).toBe(400);
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("reports a failed installation with the rechecked status", async () => {
    mocks.enabled.mockResolvedValue(["claude"]);
    const result = {
      error: "Could not check registered marketplaces. Please retry.",
      ranCommands: ["plugin marketplace list --json"],
      status: { agentType: "claude", installed: false },
    };
    mocks.install.mockResolvedValue(result);
    const response = await request({ agentType: "claude" });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(result);
  });
});
