import { beforeEach, describe, expect, it, vi } from "vitest";

import { readServiceResourcesCollectionEnabled } from "../src/observability/service-resources-settings.js";
import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const ctx = useInjectApp();
let sessionCookie: string;

beforeEach(async () => {
  sessionCookie = await ctx.sessionCookie();
});

describe("GET /ping", () => {
  it("returns ok without auth", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/v1/health", () => {
  it("returns ok with db timestamp", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.now).toBeDefined();
  });
});

describe("GET /api/v1/app/branding", () => {
  it("returns current icon color", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/branding",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.iconColor).toBe("string");
  });
});

describe("GET /api/v1/system/defaults", () => {
  it("returns homeDir", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/defaults",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.homeDir).toBe("string");
    expect(body.homeDir.length).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/system/resources", () => {
  it("returns a bounded operational snapshot", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/resources?window=15m",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.collectionEnabled).toBe(false);
    expect(body.sampleIntervalMs).toBe(5_000);
    expect(body.current.server.rssBytes).toBeGreaterThan(0);
    expect(body.current.database.pool.max).toBeGreaterThan(0);
    expect(Array.isArray(body.series)).toBe(true);
    expect(body.series.length).toBeLessThanOrEqual(720);
    if (body.series.length > 0) {
      expect(body.series[0]?.subsystems?.database?.metadata).toEqual(
        expect.objectContaining({
          poolTotal: expect.any(Number),
          poolIdle: expect.any(Number),
          poolWaiting: expect.any(Number),
        })
      );
    }
    expect(body.subsystems.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        "api-server",
        "database",
        "agent-reconciliation",
        "activity-monitor",
        "git-diff-refreshes",
      ])
    );
  });

  it("rejects unsupported history windows", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/resources?window=24h",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/window/);
  });

  it("toggles resource collection at runtime and persists the setting", async () => {
    const enable = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/system/resources/settings",
      headers: { cookie: sessionCookie },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toEqual({ collectionEnabled: true });
    expect(await readServiceResourcesCollectionEnabled(ctx.pool)).toBe(true);

    const enabledSnapshot = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/resources",
      headers: { cookie: sessionCookie },
    });
    expect(enabledSnapshot.json().collectionEnabled).toBe(true);

    const disable = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/system/resources/settings",
      headers: { cookie: sessionCookie },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toEqual({ collectionEnabled: false });
    expect(await readServiceResourcesCollectionEnabled(ctx.pool)).toBe(false);

    const disabledSnapshot = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/resources",
      headers: { cookie: sessionCookie },
    });
    expect(disabledSnapshot.json()).toMatchObject({
      collectionEnabled: false,
      series: [],
    });
  });

  it("rejects invalid resource collection settings", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/system/resources/settings",
      headers: { cookie: sessionCookie },
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabled/);
  });
});

describe("GET /api/v1/system/path-info", () => {
  it("rejects missing path parameter", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-info",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/path/i);
  });

  it("rejects empty path parameter", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-info?path=%20",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns exists=false for non-existent path", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-info?path=/tmp/dispatch-nonexistent-path-test",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(false);
    expect(body.isDirectory).toBe(false);
    expect(body.isGitRepo).toBe(false);
  });

  it("returns exists=true for /tmp", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-info?path=/tmp",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(body.isDirectory).toBe(true);
  });

  it("returns exists=false for relative path", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-info?path=relative/path",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(false);
    expect(body.resolvedPath).toBe("relative/path");
  });
});

describe("GET /api/v1/system/path-completions", () => {
  it("rejects missing prefix parameter", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-completions",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/prefix/i);
  });

  it("rejects empty prefix", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-completions?prefix=%20",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns empty completions for relative prefix", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-completions?prefix=relative",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completions).toEqual([]);
  });

  it("returns directory completions for /tmp/", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/system/path-completions?prefix=/tmp/",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.completions)).toBe(true);
  });
});

describe("GET /api/v1/git/branches", () => {
  it("rejects missing cwd parameter", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/git/branches",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cwd/i);
  });

  it("rejects empty cwd parameter", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/git/branches?cwd=%20",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/agents/settings", () => {
  it("returns settings with defaults", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.worktreeLocation).toBe("sibling");
    expect(typeof body.iconColor).toBe("string");
    expect(typeof body.instanceName).toBe("string");
  });
});

describe("POST /api/v1/agents/settings", () => {
  it("rejects invalid worktreeLocation", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { worktreeLocation: "invalid" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/worktreeLocation/);
  });

  it("rejects non-string worktreeLocation", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { worktreeLocation: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid worktreeLocation", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { worktreeLocation: "nested" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().worktreeLocation).toBe("nested");
  });

  it("rejects invalid iconColor", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { iconColor: "neon-green" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/iconColor/);
  });

  it("rejects non-string iconColor", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { iconColor: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid iconColor", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { iconColor: "blue" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().iconColor).toBe("blue");
  });

  it("rejects non-string instanceName", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { instanceName: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/instanceName/);
  });

  it("accepts and trims instanceName", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { instanceName: "  My Instance  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().instanceName).toBe("My Instance");
  });

  it("clears instanceName when set to empty string", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { instanceName: "First" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { instanceName: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().instanceName).toBe("");
  });

  it("truncates instanceName to 100 characters", async () => {
    const longName = "A".repeat(200);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/agents/settings",
      headers: { cookie: sessionCookie },
      payload: { instanceName: longName },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().instanceName.length).toBe(100);
  });
});

describe("POST /api/v1/notifications/settings", () => {
  it("rejects non-string webhookUrl", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webhookUrl: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/webhookUrl/);
  });

  it("rejects invalid webhookUrl", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webhookUrl: "https://evil.com/hook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/hooks\.slack\.com/);
  });

  it("accepts valid Slack webhookUrl", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: {
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts empty string to clear webhookUrl", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webhookUrl: "" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects non-array notifyEvents", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { notifyEvents: "done" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/notifyEvents/);
  });

  it("accepts array notifyEvents", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { notifyEvents: ["done", "blocked"] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects non-boolean webNotifyEnabled", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webNotifyEnabled: "true" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/webNotifyEnabled/);
  });

  it("accepts boolean webNotifyEnabled", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webNotifyEnabled: true },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects non-array webNotifyEvents", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webNotifyEvents: "done" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/webNotifyEvents/);
  });

  it("accepts array webNotifyEvents", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webNotifyEvents: ["done"] },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/v1/notifications/settings", () => {
  it("returns settings object", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toBeDefined();
  });
});

describe("POST /api/v1/notifications/test", () => {
  it("rejects when no webhook URL is configured or provided", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/settings",
      headers: { cookie: sessionCookie },
      payload: { webhookUrl: "" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/test",
      headers: { cookie: sessionCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/webhook/i);
  });

  it("rejects invalid webhookUrl in body", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/notifications/test",
      headers: { cookie: sessionCookie },
      payload: { webhookUrl: "https://evil.com/hook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/hooks\.slack\.com/);
  });
});

describe("GET /api/v1/app/settings/agent-types", () => {
  it("returns enabled agent types", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.enabledAgentTypes)).toBe(true);
    expect(body.enabledAgentTypes.length).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/app/settings/agent-types", () => {
  it("rejects non-array enabledAgentTypes", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: { enabledAgentTypes: "claude" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabledAgentTypes/);
  });

  it("rejects empty array", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: { enabledAgentTypes: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one/i);
  });

  it("rejects array with only invalid types", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: { enabledAgentTypes: ["invalid_type"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects array containing invalid types mixed with valid", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: { enabledAgentTypes: ["claude", "invalid_type"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabledAgentTypes must only include/);
  });

  it("accepts valid agent types", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: { enabledAgentTypes: ["claude", "codex"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabledAgentTypes).toEqual(["claude", "codex"]);
  });

  it("rejects duplicate-inflated array with unknown entries", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: { enabledAgentTypes: ["claude", "claude", "bad"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing body", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/agent-types",
      headers: { cookie: sessionCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/app/settings/ides", () => {
  it("returns enabled IDEs", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/settings/ides",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.enabledIdes)).toBe(true);
  });
});

describe("POST /api/v1/app/settings/ides", () => {
  it("rejects non-array enabledIdes", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/ides",
      headers: { cookie: sessionCookie },
      payload: { enabledIdes: "vscode" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabledIdes/);
  });

  it("rejects array with invalid IDE types", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/ides",
      headers: { cookie: sessionCookie },
      payload: { enabledIdes: ["vscode", "emacs"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabledIdes must only include/);
  });

  it("accepts valid IDE types", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/ides",
      headers: { cookie: sessionCookie },
      payload: { enabledIdes: ["vscode", "cursor"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabledIdes).toEqual(["vscode", "cursor"]);
  });

  it("accepts empty array to disable all IDEs", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/ides",
      headers: { cookie: sessionCookie },
      payload: { enabledIdes: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabledIdes).toEqual([]);
  });

  it("rejects missing body", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/ides",
      headers: { cookie: sessionCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/app/settings/cross-repo-messaging", () => {
  it("returns enabled status (defaults to false)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it("reflects updated state after POST", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: { enabled: true },
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });
});

describe("POST /api/v1/app/settings/cross-repo-messaging", () => {
  it("enables cross-repo messaging", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it("disables cross-repo messaging", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: { enabled: true },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it("rejects non-boolean enabled", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabled must be a boolean/);
  });

  it("rejects missing enabled field", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabled must be a boolean/);
  });

  it("rejects null body", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: null,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects numeric enabled", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/cross-repo-messaging",
      headers: { cookie: sessionCookie },
      payload: { enabled: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/enabled must be a boolean/);
  });
});

describe("POST /api/v1/energy-report", () => {
  it("accepts any body and returns 204", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/energy-report",
      headers: { cookie: sessionCookie },
      payload: { cpu: 42, memory: 100 },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("usage budgets settings", () => {
  const url = "/api/v1/app/settings/usage-budgets";
  it("starts empty, stores known providers, and rejects the rest", async () => {
    const empty = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: sessionCookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ budgets: {} });

    const saved = await ctx.app.inject({
      method: "POST",
      url,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { budgets: { openai: 50, google: 12.345 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ budgets: { openai: 50, google: 12.35 } });
    const read = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: sessionCookie },
    });
    expect(read.json()).toEqual({ budgets: { openai: 50, google: 12.35 } });

    for (const payload of [
      { budgets: [] },
      { budgets: { mistral: 5 } },
      { budgets: { openai: -1 } },
      { budgets: { openai: "50" } },
    ]) {
      const bad = await ctx.app.inject({
        method: "POST",
        url,
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload,
      });
      expect(bad.statusCode).toBe(400);
    }

    // An empty object clears every row.
    const cleared = await ctx.app.inject({
      method: "POST",
      url,
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { budgets: {} },
    });
    expect(cleared.json()).toEqual({ budgets: {} });
  });
});
