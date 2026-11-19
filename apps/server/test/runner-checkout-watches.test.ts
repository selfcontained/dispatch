import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { CheckoutObservers } from "../src/agents/checkout-observers.js";
import { SharedCheckoutWatches } from "../src/agents/checkout-watch.js";

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
  let ready!: (id: string) => void;
  const unsubscribe = vi.fn();
  const requestSession = vi.fn(async () => ({
    channel: new PassThrough(),
    value: true,
  }));
  const changed = vi.fn();
  const observers = new CheckoutObservers(
    {
      onConnectionChange(listener) {
        ready = listener;
        return unsubscribe;
      },
      requestSession,
    },
    changed
  );
  const agent = {
    id: "author",
    cwd: "runner://alpha/@session",
    worktreePath: null,
    baseBranch: null,
  };
  try {
    observers.observe(agent);
    observers.observe(agent);
    expect(requestSession).toHaveBeenCalledTimes(1);
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
    const replacement = (await requestSession.mock.results[1]!.value).channel;
    await vi.advanceTimersByTimeAsync(95_000);
    expect(replacement.destroyed).toBe(true);
    ready("alpha");
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    observers.close();
    vi.useRealTimers();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
});
