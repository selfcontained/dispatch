import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PairingSession,
  PENDING_PAIRING_KEY,
  type PairingSessionStorage,
  type PendingPairing,
} from "./pairing-session";

function createStorage(): PairingSessionStorage & {
  values: Record<string, unknown>;
} {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: (key) => Promise.resolve(key in values ? { [key]: values[key] } : {}),
    set: (items) => {
      Object.assign(values, items);
      return Promise.resolve();
    },
    remove: (key) => {
      delete values[key];
      return Promise.resolve();
    },
  };
}

function createPending(expiresInMs = 60_000): PendingPairing {
  return {
    baseUrl: "http://dispatch.test",
    pairingId: "pairing-1",
    pairingSecret: "secret-1",
    code: "123456",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

describe("PairingSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until the exchange approves and reports approved once", async () => {
    const storage = createStorage();
    const exchange = vi
      .fn<() => Promise<{ status: "pending" | "approved" }>>()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "approved" });
    const disconnect = vi.fn(() => Promise.resolve());
    const session = new PairingSession({ storage, exchange, disconnect });

    await session.begin(createPending());
    expect(storage.values[PENDING_PAIRING_KEY]).toMatchObject({
      kind: "pending",
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(storage.values[PENDING_PAIRING_KEY]).toMatchObject({
      kind: "pending",
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(storage.values[PENDING_PAIRING_KEY]).toMatchObject({
      kind: "approved",
    });

    await expect(session.status()).resolves.toEqual({
      state: "approved",
      baseUrl: "http://dispatch.test",
    });
    await expect(session.status()).resolves.toEqual({ state: "idle" });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("resumes a persisted pairing after a background restart via status()", async () => {
    const storage = createStorage();
    const pending = createPending();
    storage.values[PENDING_PAIRING_KEY] = { kind: "pending", pending };

    const exchange = vi
      .fn<() => Promise<{ status: "pending" | "approved" }>>()
      .mockResolvedValue({ status: "approved" });
    const session = new PairingSession({
      storage,
      exchange,
      disconnect: () => Promise.resolve(),
    });

    await expect(session.status()).resolves.toEqual({
      state: "approved",
      baseUrl: "http://dispatch.test",
    });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(storage.values[PENDING_PAIRING_KEY]).toBeUndefined();
  });

  it("keeps polling after status() while the pairing stays pending", async () => {
    const storage = createStorage();
    const pending = createPending();
    storage.values[PENDING_PAIRING_KEY] = { kind: "pending", pending };

    const exchange = vi
      .fn<() => Promise<{ status: "pending" | "approved" }>>()
      .mockResolvedValue({ status: "pending" });
    const session = new PairingSession({
      storage,
      exchange,
      disconnect: () => Promise.resolve(),
    });

    await expect(session.status()).resolves.toMatchObject({
      state: "pending",
      code: "123456",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exchange.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("expires a stale pairing", async () => {
    const storage = createStorage();
    storage.values[PENDING_PAIRING_KEY] = {
      kind: "pending",
      pending: createPending(-1_000),
    };
    const exchange = vi.fn<() => Promise<{ status: "pending" | "approved" }>>();
    const session = new PairingSession({
      storage,
      exchange,
      disconnect: () => Promise.resolve(),
    });

    await expect(session.status()).resolves.toEqual({ state: "expired" });
    expect(exchange).not.toHaveBeenCalled();
    expect(storage.values[PENDING_PAIRING_KEY]).toBeUndefined();
  });

  it("disconnects when a cancel races a late approval", async () => {
    const storage = createStorage();
    const resolvers: Array<
      (value: { status: "pending" | "approved" }) => void
    > = [];
    const exchange = vi.fn(
      () =>
        new Promise<{ status: "pending" | "approved" }>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const disconnect = vi.fn(() => Promise.resolve());
    const session = new PairingSession({ storage, exchange, disconnect });

    await session.begin(createPending());
    await vi.advanceTimersByTimeAsync(2_500);
    expect(exchange).toHaveBeenCalledTimes(1);

    const cancelled = session.cancel();
    resolvers[0]?.({ status: "approved" });
    await cancelled;

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(storage.values[PENDING_PAIRING_KEY]).toBeUndefined();
    await expect(session.status()).resolves.toEqual({ state: "idle" });
  });

  it("cancel without a late approval leaves the connection alone", async () => {
    const storage = createStorage();
    const exchange = vi
      .fn<() => Promise<{ status: "pending" | "approved" }>>()
      .mockResolvedValue({ status: "pending" });
    const disconnect = vi.fn(() => Promise.resolve());
    const session = new PairingSession({ storage, exchange, disconnect });

    await session.begin(createPending());
    await vi.advanceTimersByTimeAsync(2_500);
    await session.cancel();

    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});
