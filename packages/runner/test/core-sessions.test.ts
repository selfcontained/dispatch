/*
 * The session core over in-memory ports: records, the lock, the order of
 * stop and inspection steps, and descendant cleanup after a host exits.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionCore,
  parseLaunchRecord,
  readLogTail,
  type SessionProcessPort,
} from "../src/core/sessions.js";

type Identity = { marker: string; pid: number };

function setup(options: { live?: Set<number>; sockets?: Set<string> } = {}) {
  const live = options.live ?? new Set<number>();
  const sockets = options.sockets ?? new Set<string>();
  const files = new Map<string, string>();
  const calls: string[] = [];
  const logs = mkdtempSync(join(tmpdir(), "core-sessions-"));
  const processes: SessionProcessPort<Identity> = {
    alive: (identity) => live.has(identity.pid),
    spawn: vi.fn(async (_command, _cwd, _env, _log, record) => {
      await record({ marker: "m-new", pid: 42 });
      live.add(42);
    }),
    stop: vi.fn(async (identity: Identity) => {
      calls.push(`stop ${identity.pid}`);
      live.delete(identity.pid);
    }),
    cleanup: vi.fn(async (identity: Identity) => {
      calls.push(`cleanup ${identity.marker}`);
    }),
    cleanupLegacy: vi.fn(async (marker: string) => {
      calls.push(`legacy ${marker}`);
    }),
    socketMatchesHost: vi.fn(() => true),
    socketInUse: (socket) => sockets.has(socket),
    pinSocket: () => {
      throw new Error("no socket");
    },
    parseIdentity: (raw) => JSON.parse(raw),
  };
  const core = createSessionCore({
    processes,
    layout: {
      hostDir: (key) => `/hosts/${key}`,
      socket: (key) => `/hosts/${key}/socket`,
      sockets: (key) => [`/hosts/${key}/socket`],
      identityFile: (key) => `${key}.host`,
      markerFile: (key) => `${key}.owner`,
      launchFile: (key) => `${key}.launch`,
      logFile: (key) => join(logs, key),
      trackedKeys: async () =>
        [...files.keys()]
          .filter((file) => file.endsWith(".host"))
          .map((file) => file.slice(0, -5)),
    },
    state: {
      read: async (file) => files.get(file) ?? null,
      write: async (file, contents) => {
        files.set(file, contents);
      },
      remove: async (file) => {
        calls.push(`remove ${file}`);
        files.delete(file);
      },
      exists: async (file) => files.has(file),
      openPrivate: async (file) => {
        const contents = files.get(file);
        if (contents === undefined) return null;
        return {
          trusted: async () => true,
          read: async () => contents,
          close: async () => {},
        };
      },
    },
    sweepMs: 20,
  });
  cleanups.push(() => {
    core.close();
    rmSync(logs, { recursive: true, force: true });
  });
  return { core, files, calls, live, sockets, processes, logs };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("launch records", () => {
  it("parses only the known stages", () => {
    expect(parseLaunchRecord(null)).toBeNull();
    expect(parseLaunchRecord("{")).toBeNull();
    expect(parseLaunchRecord('{"launchId":"a","stage":"later"}')).toBeNull();
    expect(
      parseLaunchRecord(
        '{"launchId":"a","stage":"spawning","hostInstanceId":"h","dependencies":"done"}'
      )
    ).toEqual({
      launchId: "a",
      stage: "spawning",
      hostInstanceId: "h",
      dependencies: "done",
    });
  });

  it("round-trips through private state", async () => {
    const { core } = setup();
    await core.saveLaunch("k", { launchId: "a", stage: "preparing" });
    expect(await core.readLaunch("k")).toEqual({
      launchId: "a",
      stage: "preparing",
    });
    await core.removeLaunch("k");
    expect(await core.readLaunch("k")).toBeNull();
  });
});

describe("the session lock", () => {
  it("runs one key's operations in order, and survives a failure", async () => {
    const { core } = setup();
    const order: string[] = [];
    const first = core.lock("k", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
      throw new Error("boom");
    });
    const second = core.lock("k", async () => order.push("second"));
    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("takes several keys in a stable order", async () => {
    const { core } = setup();
    const order: string[] = [];
    const held = core.lock("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a");
    });
    await core.locks(["b", "a"], async () => order.push("both"));
    await held;
    expect(order).toEqual(["a", "both"]);
  });
});

describe("hosts", () => {
  it("records a spawned host with the caller's fields after the platform identity", async () => {
    const { core, files } = setup();
    await core.spawn("k", () => ["/host"], "/cwd", {}, { instance: "i" });
    expect(files.get("k.host")).toBe(
      JSON.stringify({ marker: "m-new", pid: 42, instance: "i" })
    );
    expect(await core.alive("k")).toBe(true);
  });

  it("refuses an empty host command after opening the log", async () => {
    const { core, processes } = setup();
    await expect(core.spawn("k", () => [], "/cwd", {}, {})).rejects.toThrow(
      "Runner host executable is missing"
    );
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  it("stops, cleans descendants, then drops the record and the legacy marker", async () => {
    const { core, files, calls } = setup({ live: new Set([7]) });
    files.set("k.host", JSON.stringify({ marker: "m", pid: 7 }));
    files.set("k.owner", "old");
    await core.stop("k", false);
    expect(calls).toEqual([
      "stop 7",
      "cleanup m",
      "remove k.host",
      "legacy old",
      "remove k.owner",
    ]);
  });

  it("fails a stop whose host socket outlives the bounded drain wait", async () => {
    const { core, files } = setup({
      live: new Set([7]),
      sockets: new Set(["/hosts/k/socket"]),
    });
    files.set("k.host", JSON.stringify({ marker: "m", pid: 7 }));
    const started = performance.now();
    await expect(core.stop("k", true)).rejects.toThrow(
      "Runner cannot verify ownership of the existing guest host."
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  });

  it("refuses an untracked live socket when no host is recorded", async () => {
    const { core } = setup({ sockets: new Set(["/hosts/k/socket"]) });
    await expect(core.stop("k", false)).rejects.toThrow(
      "Runner cannot verify ownership"
    );
  });

  it("attaches to nothing when the recorded host is gone", async () => {
    const { core, files } = setup();
    files.set("k.host", JSON.stringify({ marker: "m", pid: 7 }));
    expect(await core.attach("k")).toBeNull();
  });

  it("sweeps the descendants of a host that exited while unwatched", async () => {
    const { core, files, calls } = setup();
    files.set("k.host", JSON.stringify({ marker: "m", pid: 7 }));
    await vi.waitFor(() => expect(files.has("k.host")).toBe(false));
    expect(calls).toContain("cleanup m");
    core.close();
  });

  it("reports the log tail with liveness", async () => {
    const { core, logs } = setup();
    writeFileSync(join(logs, "k"), "é".repeat(2000));
    const { live, text } = await core.logs("k");
    expect(live).toBe(false);
    expect(text.startsWith("é")).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
    expect(await readLogTail(join(logs, "missing"))).toBe("");
  });
});

describe("inspection", () => {
  it("never checks the socket of a host its caller could not verify", async () => {
    const { core, files, processes } = setup({ live: new Set([7]) });
    files.set("k.host", JSON.stringify({ marker: "m", pid: 7 }));
    expect(await core.inspect("k", async () => false)).toBeUndefined();
    expect(processes.socketMatchesHost).not.toHaveBeenCalled();
    expect(await core.inspect("k", async () => true)).toEqual({
      marker: "m",
      pid: 7,
    });
  });

  it("distinguishes no host from an unverifiable one", async () => {
    const { core, files, sockets } = setup();
    expect(await core.inspect("k", async () => true)).toBeNull();
    files.set("k.owner", "old");
    expect(await core.inspect("k", async () => true)).toBeUndefined();
    files.delete("k.owner");
    sockets.add("/hosts/k/socket");
    expect(await core.inspect("k", async () => true)).toBeUndefined();
  });
});
