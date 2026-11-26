import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { CheckoutObservers } from "../src/agents/checkout-observers.js";
import { SharedCheckoutWatches } from "../../../packages/runner/src/workload/agents/checkout-watch.js";

it("shares one watch between readers and reopens after an OS watch fails", () => {
  const close = vi.fn();
  const open = vi.fn(
    (_root: string, _changed: () => void, _closed: () => void) => close
  );
  const watches = new SharedCheckoutWatches(open);
  const first = vi.fn(),
    second = vi.fn(),
    end = vi.fn();
  const unsubscribe = watches.subscribe("/checkout", first, end);
  watches.subscribe("/checkout", second, end);
  expect(open).toHaveBeenCalledTimes(1);
  open.mock.calls[0]![1]();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(close).not.toHaveBeenCalled();
  open.mock.calls[0]![2]();
  expect(end).toHaveBeenCalledTimes(1);
  watches.subscribe("/checkout", first, end)();
  expect(open).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(1);
});
it("reconnects interested sessions and releases leases that stop receiving reads", async () => {
  vi.useFakeTimers();
  const listeners = new Set<(id: string) => void>();
  const ready = (id: string) => {
    for (const listener of [...listeners]) listener(id);
  };
  const requestSession = vi.fn(async () => ({
    channel: new PassThrough(),
    value: true,
  }));
  const changed = vi.fn();
  const remote = {
    onConnectionChange(listener: (id: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestSession,
  };
  const observers = new CheckoutObservers(
    () => ({ local: undefined, remote: remote as never }),
    changed
  );
  const agent = {
    id: "author",
    cwd: "runner://alpha/@session",
    worktreePath: null,
    workspacePath: null,
    baseBranch: null,
  };
  try {
    observers.observe(agent);
    observers.observe(agent);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSession).toHaveBeenCalledTimes(1);
    expect(requestSession.mock.calls[0]).toEqual([
      { runner: "alpha", workspace: "@session" },
      { kind: "watchCheckout", agentId: "author" },
      undefined,
      undefined,
    ]);
    const channel = (await requestSession.mock.results[0]!.value).channel;
    channel.write("1");
    channel.write("1");
    await vi.advanceTimersByTimeAsync(150);
    expect(changed.mock.calls).toEqual([["author"]]);
    ready("beta");
    expect(channel.destroyed).toBe(false);
    ready("alpha");
    expect(channel.destroyed).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    observers.observe(agent);
    await vi.advanceTimersByTimeAsync(0);
    const replacement = (await requestSession.mock.results[1]!.value).channel;
    await vi.advanceTimersByTimeAsync(95_000);
    expect(replacement.destroyed).toBe(true);
    ready("alpha");
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    observers.close();
    vi.useRealTimers();
  }
  expect(listeners.size).toBe(0);
});

it("watches a local checkout in process once per directory, as main", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "observers-"));
  const changed = vi.fn();
  const observers = new CheckoutObservers(
    () => ({ local: undefined }),
    changed
  );
  const agent = (id: string) => ({
    id,
    cwd: root,
    worktreePath: null,
    workspacePath: null,
    baseBranch: null,
  });
  try {
    observers.observe(agent("author"));
    observers.observe(agent("reviewer"));
    // The watch reconciles once after it is set up, then reports a change.
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2), {
      interval: 20,
      timeout: 2_000,
    });
    expect(changed.mock.calls.sort()).toEqual([["author"], ["reviewer"]]);
  } finally {
    observers.close();
    await rm(root, { recursive: true, force: true });
  }
});
