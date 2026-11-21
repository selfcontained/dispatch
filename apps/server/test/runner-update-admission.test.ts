import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FENCE_FLUSH_MARGIN_MS,
  UpdateAdmission,
} from "../src/agents/remote/update-admission.js";
import { fileFenceStore } from "../src/agents/remote/update-fence-store.js";
import { fenceRecord, memoryStore } from "./runner-update-fixtures.js";

describe("update admission gate", () => {
  afterEach(() => vi.useRealTimers());

  it("admits while open and refuses once the fence closes", async () => {
    const store = memoryStore();
    const gate = await UpdateAdmission.load(store);
    expect(gate.admit(1000)).not.toBeNull();
    const ticket = gate.admit(1000)!;
    ticket.release();
    const draining = gate.fence(fenceRecord);
    // Closed synchronously, before the record is persisted.
    expect(gate.admit(1000)).toBeNull();
    expect(gate.closed).toBe(true);
    await vi.waitFor(() => expect(store.write).toHaveBeenCalled());
    expect(store.record?.phase).toBe("fencing");
    // One admitted ticket is still outstanding.
    expect(gate.inFlight).toBe(1);
    expect(gate.mayStartProcess()).toBe(true);
    await gate.release();
    await expect(draining).resolves.toBe("cancelled");
  });

  it("waits for admitted work, then refuses every process start", async () => {
    const gate = await UpdateAdmission.load(memoryStore());
    const ticket = gate.admit(10_000)!;
    let outcome: string | undefined;
    const draining = gate.fence(fenceRecord).then((value) => (outcome = value));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outcome).toBeUndefined();
    ticket.release();
    ticket.release();
    await expect(draining).resolves.toBe("drained");
    expect(gate.mayStartProcess()).toBe(false);
    expect(() => gate.assertMayStartProcess()).toThrow("was not started");
  });

  it("defers and reopens when admitted work outlives its deadline", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const gate = await UpdateAdmission.load(store);
    gate.admit(1_000);
    const draining = gate.fence(fenceRecord);
    await vi.advanceTimersByTimeAsync(1_000 + FENCE_FLUSH_MARGIN_MS - 1);
    expect(gate.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    await expect(draining).resolves.toBe("timeout");
    expect(gate.closed).toBe(false);
    expect(store.record).toBeNull();
    expect(gate.admit(1000)).not.toBeNull();
  });

  it("reopens when the fence cannot be persisted", async () => {
    const store = memoryStore();
    store.fail = true;
    const gate = await UpdateAdmission.load(store);
    await expect(gate.fence(fenceRecord)).resolves.toBe("store_failed");
    expect(gate.closed).toBe(false);
  });

  it("starts closed from a persisted record and from unreadable state", async () => {
    const persisted = await UpdateAdmission.load(
      memoryStore({ ...fenceRecord, phase: "activating" })
    );
    expect(persisted.closed).toBe(true);
    expect(persisted.current?.phase).toBe("activating");
    expect(persisted.admit(1000)).toBeNull();
    expect(persisted.mayStartProcess()).toBe(false);

    const broken = memoryStore();
    broken.read.mockRejectedValueOnce(new Error("not private"));
    const log = vi.fn();
    const unreadable = await UpdateAdmission.load(broken, { log });
    expect(unreadable.closed).toBe(true);
    expect(unreadable.unreadable).toBe(true);
    expect(unreadable.current).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not private"));
    await unreadable.release();
    expect(unreadable.closed).toBe(false);
  });

  it("closes terminals after the grace period, not before", async () => {
    vi.useFakeTimers();
    const gate = await UpdateAdmission.load(memoryStore(), {
      terminalGraceMs: 5_000,
    });
    const open = vi.fn();
    const cancelled = vi.fn();
    gate.onTerminal(open);
    gate.onTerminal(cancelled)();
    await expect(gate.fence(fenceRecord)).resolves.toBe("drained");
    const closing = gate.closeTerminals();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(open).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    // One that registers late (its open was admitted earlier) closes at once.
    const late = vi.fn();
    gate.onTerminal(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("keeps terminals when the fence is released during the grace period", async () => {
    vi.useFakeTimers();
    const gate = await UpdateAdmission.load(memoryStore(), {
      terminalGraceMs: 5_000,
    });
    const terminal = vi.fn();
    gate.onTerminal(terminal);
    await expect(gate.fence(fenceRecord)).resolves.toBe("drained");
    const closing = gate.closeTerminals();
    await vi.advanceTimersByTimeAsync(1_000);
    await gate.release();
    await closing;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminal).not.toHaveBeenCalled();
  });

  it("keeps cancellation durable when it races a pending phase write", async () => {
    const store = memoryStore();
    const gate = await UpdateAdmission.load(store);
    await gate.fence(fenceRecord);
    let finish!: () => void;
    store.write.mockImplementationOnce(async (record) => {
      await new Promise<void>((resolve) => (finish = resolve));
      store.record = record;
    });
    const phase = gate.advance("fenced");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const released = gate.release();
    finish();
    await expect(phase).resolves.toBe(false);
    await released;
    expect(store.record).toBeNull();
    expect(gate.closed).toBe(false);
  });

  it("persists phase and retained set", async () => {
    const store = memoryStore();
    const gate = await UpdateAdmission.load(store);
    await gate.fence(fenceRecord);
    const retained = [
      {
        sessionId: "agt_one",
        instanceId: "00000000-0000-4000-8000-000000000001",
      },
    ];
    await gate.advance("fenced", retained);
    expect(store.record).toMatchObject({ phase: "fenced", retained });
    await gate.advance("activating");
    expect(store.record).toMatchObject({ phase: "activating", retained });
  });
});

describe("file fence store", () => {
  let root: string;
  let state: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-fence-"));
    state = path.join(root, "update");
    await mkdir(state, { mode: 0o700 });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("round-trips a private, synced record", async () => {
    const store = fileFenceStore(state);
    expect(await store.read()).toBeNull();
    await store.write(fenceRecord);
    const file = path.join(state, "fence.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(fenceRecord);
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it("uses the file timestamp for a record written by the earlier supervisor", async () => {
    const { startedAt: _, ...legacy } = fenceRecord;
    const file = path.join(state, "fence.json");
    await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
    expect(await fileFenceStore(state).read()).toEqual({
      ...legacy,
      startedAt: Math.trunc((await stat(file)).mtimeMs),
    });
  });

  it("treats a missing updater directory as no fence", async () => {
    expect(await fileFenceStore(path.join(root, "absent")).read()).toBeNull();
  });

  it("ignores directory permissions until a fence exists", async () => {
    await chmod(state, 0o755);
    const store = fileFenceStore(state);
    expect(await store.read()).toBeNull();
    await expect(store.write(fenceRecord)).rejects.toThrow("not private");
  });

  it.each([
    [
      "malformed JSON",
      async (file: string) => writeFile(file, "{", { mode: 0o600 }),
    ],
    [
      "unknown phase",
      async (file: string) =>
        writeFile(file, JSON.stringify({ ...fenceRecord, phase: "renamed" }), {
          mode: 0o600,
        }),
    ],
    [
      "readable by others",
      async (file: string) =>
        writeFile(file, JSON.stringify(fenceRecord), { mode: 0o644 }),
    ],
    [
      "symlink",
      async (file: string) => {
        const real = path.join(root, "elsewhere.json");
        await writeFile(real, JSON.stringify(fenceRecord), { mode: 0o600 });
        await symlink(real, file);
      },
    ],
    [
      "timestamp is a string",
      async (file: string) =>
        writeFile(file, JSON.stringify({ ...fenceRecord, startedAt: "1" }), {
          mode: 0o600,
        }),
    ],
    [
      "timestamp is fractional",
      async (file: string) =>
        writeFile(file, JSON.stringify({ ...fenceRecord, startedAt: 0.5 }), {
          mode: 0o600,
        }),
    ],
    [
      "timestamp is negative",
      async (file: string) =>
        writeFile(file, JSON.stringify({ ...fenceRecord, startedAt: -1 }), {
          mode: 0o600,
        }),
    ],
  ])("refuses a fence that is %s", async (_, plant) => {
    await plant(path.join(state, "fence.json"));
    await expect(fileFenceStore(state).read()).rejects.toThrow();
  });

  it("refuses a fence in a shared directory", async () => {
    await fileFenceStore(state).write(fenceRecord);
    await chmod(state, 0o755);
    await expect(fileFenceStore(state).read()).rejects.toThrow("not private");
    await chmod(state, 0o700);
    expect(
      JSON.parse(await readFile(path.join(state, "fence.json"), "utf8"))
    ).toEqual(fenceRecord);
  });
});
