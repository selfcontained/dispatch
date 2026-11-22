import { describe, expect, it, vi } from "vitest";

import type { EngineLogin, EngineAuthStatus } from "@dispatch/shared";
import type { EngineOperationEvent } from "@dispatch/runner-protocol/engine-management";

import {
  EngineManager,
  type RunnerEngineTransport,
} from "../src/agents/remote/engine-manager.js";
import type { EngineLogins } from "../src/agents/engine-login.js";
import type { EngineUpdateOperations } from "../src/agents/engine-updates.js";

vi.mock("../src/agents/engine-availability.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/agents/engine-availability.js")
  >("../src/agents/engine-availability.js");
  return {
    ...actual,
    engineStatuses: vi.fn(async () => [
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        path: "/bin/claude",
        version: null,
        install: "",
      },
      {
        id: "codex",
        label: "Codex",
        installed: false,
        path: null,
        version: null,
        install: "",
      },
      {
        id: "opencode",
        label: "OpenCode",
        installed: false,
        path: null,
        version: null,
        install: "",
      },
    ]),
    withEngineVersions: vi.fn(async (statuses) =>
      statuses.map((s: any) => ({
        ...s,
        version: s.installed ? "1.2.3" : null,
      }))
    ),
  };
});

vi.mock("../src/agents/engine-updates.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/agents/engine-updates.js")
  >("../src/agents/engine-updates.js");
  return {
    ...actual,
    withEngineUpdates: vi.fn(async (statuses) =>
      statuses.map((s: any) => ({
        ...s,
        update: {
          canUpdate: s.installed,
          available: false,
          reason: "",
          command: "",
          latestVersion: null,
          latestPending: false,
        },
      }))
    ),
  };
});

function fakeLogins(overrides: Partial<EngineLogins> = {}): EngineLogins {
  return {
    status: vi.fn(
      async (): Promise<EngineAuthStatus> => ({
        engine: "claude",
        installed: true,
        signedIn: true,
        detail: "me@example.com",
      })
    ),
    start: vi.fn(
      async (): Promise<EngineLogin> => ({
        id: "login-1",
        engine: "claude",
        status: "waiting",
        needsCode: true,
        url: "https://example.com",
        expiresAt: new Date().toISOString(),
      })
    ),
    submitCode: vi.fn(() => null),
    cancel: vi.fn(() => null),
    get: vi.fn(() => null),
    current: vi.fn(() => null),
    close: vi.fn(),
    ...overrides,
  } as unknown as EngineLogins;
}

function fakeUpdates(
  overrides: Partial<EngineUpdateOperations> = {}
): EngineUpdateOperations {
  return {
    start: vi.fn(async () => ({ id: "op-1" })),
    read: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as EngineUpdateOperations;
}

function fakeTransport(
  overrides: Partial<RunnerEngineTransport> = {}
): RunnerEngineTransport {
  return {
    send: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  };
}

describe("EngineManager local scope", () => {
  it("builds inventory from existing engine-availability/engine-login collaborators", async () => {
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: fakeTransport(),
    });
    const inventory = await manager.inventory({ kind: "local" });
    const claude = inventory.find((e) => e.id === "claude")!;
    expect(claude.installed).toBe(true);
    expect(claude.version).toBe("1.2.3");
    expect(claude.signedIn).toBe(true);
    expect(claude.actions).toEqual(["update", "login", "login_cancel"]);

    const codex = inventory.find((e) => e.id === "codex")!;
    expect(codex.installed).toBe(false);
    expect(codex.actions).toEqual([]);
  });

  it("never offers automatic install locally", async () => {
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: fakeTransport(),
    });
    const ack = await manager.rpc(
      { kind: "local" },
      { type: "install", engine: "claude" }
    );
    expect(ack).toMatchObject({ ok: false, unsupported: true });
  });

  it("routes update through the existing EngineUpdateOperations", async () => {
    const updates = fakeUpdates();
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates },
      remote: fakeTransport(),
    });
    const ack = await manager.rpc(
      { kind: "local" },
      { type: "update", engine: "claude" }
    );
    expect(ack).toMatchObject({ ok: true, operationId: "op-1" });
    expect(updates.start).toHaveBeenCalledWith("claude", {});
  });

  it("routes sign-in through the existing EngineLogins", async () => {
    const logins = fakeLogins();
    const manager = new EngineManager({
      local: { logins, updates: fakeUpdates() },
      remote: fakeTransport(),
    });
    const ack = await manager.rpc(
      { kind: "local" },
      { type: "login_start", engine: "claude" }
    );
    expect(ack.ok).toBe(true);
    expect(logins.start).toHaveBeenCalledWith("claude", { restart: undefined });
  });
});

describe("EngineManager runner scope", () => {
  it("forwards operations to the injected transport", async () => {
    const transport = fakeTransport();
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: transport,
    });
    await manager.rpc(
      { kind: "runner", runnerId: "r1" },
      { type: "login_start", engine: "claude" }
    );
    expect(transport.send).toHaveBeenCalledWith(
      "r1",
      { type: "login_start", engine: "claude" },
      undefined
    );
  });

  it("reads inventory from the runner's streamed inventory event", async () => {
    const transport = fakeTransport({
      send: vi.fn(async (_r, _op, onEvent) => {
        onEvent?.({
          type: "inventory",
          entries: [
            {
              id: "claude",
              label: "Claude Code",
              installed: true,
              signedIn: true,
              version: "9.9.9",
              actions: ["login"],
            },
          ],
        } satisfies EngineOperationEvent);
        return { ok: true };
      }),
    });
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: transport,
    });
    const inventory = await manager.inventory({
      kind: "runner",
      runnerId: "r1",
    });
    expect(inventory).toEqual([
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        signedIn: true,
        version: "9.9.9",
        actions: ["login"],
      },
    ]);
  });

  it("falls back to unknown entries when a runner doesn't support engine management", async () => {
    const transport = fakeTransport({
      send: vi.fn(async () => ({
        ok: false,
        error: "unknown command",
        unsupported: true,
      })),
    });
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: transport,
    });
    const inventory = await manager.inventory({
      kind: "runner",
      runnerId: "r1",
    });
    expect(inventory.every((e) => !e.installed && e.signedIn === null)).toBe(
      true
    );
    expect(inventory).toHaveLength(3);
  });

  it("announces nothing while a runner's engines are unknown", async () => {
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: fakeTransport({
        send: vi.fn(async () => ({ ok: false, error: "fenced" })),
      }),
    });
    const scope = { kind: "runner" as const, runnerId: "r1" };
    const listener = vi.fn();
    manager.onChanged(scope, listener);
    expect(await manager.inventory(scope)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies onChanged listeners after a state-changing operation", async () => {
    const transport = fakeTransport({
      send: vi.fn(async (_r, op) => {
        if (op.type === "status") {
          return { ok: true };
        }
        return { ok: true };
      }),
    });
    const manager = new EngineManager({
      local: { logins: fakeLogins(), updates: fakeUpdates() },
      remote: transport,
    });
    const scope = { kind: "runner" as const, runnerId: "r1" };
    const listener = vi.fn();
    const unsubscribe = manager.onChanged(scope, listener);
    await manager.rpc(scope, { type: "login_start", engine: "claude" });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
