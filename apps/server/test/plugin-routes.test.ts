import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginStatusChecker,
  type PluginStatusLogger,
} from "../src/shared/plugin-status.js";
import { findEngineBin } from "../src/agents/engine-availability.js";
import { registerPluginRoutes } from "../src/routes/plugin.js";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  getStatus: vi.fn(),
  findEngineBin: vi.fn(),
  checkerDeps: null as null | {
    binFor: (agentType: "claude" | "codex") => string | Promise<string>;
  },
}));
vi.mock("../src/agents/engine-availability.js", () => ({
  findEngineBin: mocks.findEngineBin,
}));
vi.mock("../src/agent-type-settings.js", () => ({
  getEnabledAgentTypes: mocks.enabled,
}));
vi.mock("../src/shared/plugin-status.js", async (original) => ({
  ...(await original<typeof import("../src/shared/plugin-status.js")>()),
  createPluginStatusChecker: (deps: typeof mocks.checkerDeps) => {
    mocks.checkerDeps = deps;
    return {
      install: mocks.install,
      update: mocks.update,
      getStatus: mocks.getStatus,
    };
  },
}));
afterEach(() => vi.resetAllMocks());
// The route pins depend on the checker interface, not the removed local side channel.
function pluginsForTest(options: {
  bins?: { claude: string; codex: string };
  logger?: PluginStatusLogger;
}) {
  const bins = options.bins ?? { claude: "claude", codex: "codex" };
  return createPluginStatusChecker({
    binFor: async (engine) =>
      (await findEngineBin(bins[engine])) ?? bins[engine],
    logger: options.logger,
  });
}
async function request(body: unknown) {
  const app = Fastify();
  try {
    await registerPluginRoutes(app, {
      pool: {} as Pool,
      plugins: pluginsForTest({ logger: app.log }),
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

describe("plugin CLI resolution", () => {
  it("runs the CLI agent launches would find, not the bare configured name", async () => {
    const app = Fastify();
    await registerPluginRoutes(app, {
      pool: {} as Pool,
      plugins: pluginsForTest({
        bins: { claude: "claude", codex: "codex" },
        logger: app.log,
      }),
    });
    await app.close();
    mocks.findEngineBin.mockImplementation(async (bin: string) =>
      bin === "claude" ? "/Users/me/.local/bin/claude" : null
    );
    // Found off the service PATH: the absolute path.
    await expect(mocks.checkerDeps!.binFor("claude")).resolves.toBe(
      "/Users/me/.local/bin/claude"
    );
    // Not found anywhere: the configured name, so the probe reports it.
    await expect(mocks.checkerDeps!.binFor("codex")).resolves.toBe("codex");
  });
});

// Parity pin: origin/main 6ab845b2 routes/plugin.ts. Keep these assertions
// unchanged when moving the checker behind the runner interface.
describe("main plugin route parity", () => {
  it.each(["true", "1", "false", "0", "TRUE", ""])(
    "preserves enabled-type order and refresh parsing for %j",
    async (refresh) => {
      const app = Fastify();
      const status = (agentType: string) => ({
        agentType,
        installed: false,
        enabled: false,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
      });
      mocks.enabled.mockResolvedValue(["codex", "opencode", "claude"]);
      mocks.getStatus.mockImplementation(async (type) => status(type));
      try {
        await registerPluginRoutes(app, {
          pool: {} as Pool,
          plugins: pluginsForTest({ logger: app.log }),
        });
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/plugin/status?refresh=${refresh}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          statuses: [status("claude"), status("codex")],
        });
        expect(mocks.getStatus.mock.calls).toEqual([
          ["claude", { forceRefresh: refresh === "true" || refresh === "1" }],
          ["codex", { forceRefresh: refresh === "true" || refresh === "1" }],
        ]);
      } finally {
        await app.close();
      }
    }
  );
  it("returns an empty statuses envelope when no plugin engine is enabled", async () => {
    const app = Fastify();
    mocks.enabled.mockResolvedValue(["opencode"]);
    try {
      await registerPluginRoutes(app, {
        pool: {} as Pool,
        plugins: pluginsForTest({ logger: app.log }),
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/plugin/status",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ statuses: [] });
      expect(mocks.getStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
