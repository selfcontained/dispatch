import { expect, it, vi } from "vitest";
import { GitHubPullRequestWatches } from "../src/agents/remote/github-pull-request-watches.js";
import type { GitHubPullRequestObservation } from "@dispatch/runner-protocol";

const target = { owner: "owner", repo: "repo", number: 42 };
const observation: GitHubPullRequestObservation = {
  state: "OPEN",
  draft: false,
  title: "Original",
  head: "a".repeat(40),
  rollup: [],
};
const event = (title: string) => ({
  type: "observation",
  observation: expect.objectContaining({ title }),
});

it("shares samples, repairs a missed update with a full observation, and stops after the last close", async () => {
  vi.useFakeTimers();
  try {
    let title = "Original";
    const read = vi.fn(async () => ({ ...observation, title }));
    const watches = new GitHubPullRequestWatches(read);
    const first = vi.fn();
    const second = vi.fn();
    const closeFirst = watches.subscribe([target], first);
    await vi.advanceTimersByTimeAsync(1);
    const closeSecond = watches.subscribe(
      [{ ...target, owner: "OWNER" }],
      second
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith(first.mock.lastCall![0]);

    title = "Changed";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first).toHaveBeenLastCalledWith(
      expect.objectContaining(event(title))
    );
    second.mockClear(); // Simulate a host missing the change.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...event(title),
        observedAt: expect.any(Number),
      })
    );
    title = "Manual";
    expect(await watches.refreshIfWatched(target)).toMatchObject({ title });
    expect(first).toHaveBeenLastCalledWith(
      expect.objectContaining(event(title))
    );
    closeFirst();
    closeSecond();
    const count = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(count);
  } finally {
    vi.useRealTimers();
  }
});

it("bounds provider calls and drops an in-flight private sample at logout", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: GitHubPullRequestObservation) => void;
    const read = vi
      .fn(async () => observation)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
    const watches = new GitHubPullRequestWatches(read);
    const receiver = vi.fn();
    const close = watches.subscribe([target], receiver);
    await vi.advanceTimersByTimeAsync(1);
    const manual = watches.refreshIfWatched(target)!;
    const rejected = expect(manual).rejects.toThrow("account changed");
    let resume!: () => void;
    const logout = watches.accountOperation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        })
    );
    finish(observation);
    await rejected;
    expect(receiver.mock.calls).toEqual([[{ type: "reset" }]]);
    read.mockRejectedValue(new Error("Signed out"));
    resume();
    await logout;
    await vi.advanceTimersByTimeAsync(1);
    expect(receiver).toHaveBeenLastCalledWith(
      expect.objectContaining({ observation: null })
    );

    const closeMany = watches.subscribe(
      Array.from({ length: 16 }, (_, i) => ({ ...target, number: i + 1 })),
      vi.fn()
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(12);
    await expect(watches.refreshIfWatched(target)!).rejects.toThrow("budget");
    closeMany();
    close();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps open PRs responsive while replaying merged snapshots without provider reads", async () => {
  vi.useFakeTimers();
  try {
    const merged = { ...observation, state: "MERGED" as const };
    const open = { ...target, number: 1 };
    const closed = { ...target, number: 2 };
    const targets = [
      ...Array.from({ length: 10 }, (_, i) => ({ ...target, number: i + 3 })),
      open,
      closed,
    ];
    const read = vi.fn(async ({ number }: typeof target) =>
      number === open.number
        ? observation
        : number === closed.number
          ? { ...observation, state: "CLOSED" as const }
          : merged
    );
    const watches = new GitHubPullRequestWatches(read);
    const receive = vi.fn();
    const close = watches.subscribe(targets, receive);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(12);
    const cached = receive.mock.calls.find(
      ([sample]) => sample.observation?.state === "MERGED"
    )![0];

    // The first minute is at capacity. Merged PRs no longer contend for
    // provider work after that window, and their original snapshot replays.
    receive.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    const newReads = read.mock.calls.slice(12);
    expect(newReads.length).toBeGreaterThanOrEqual(3);
    expect(newReads.every(([pr]) => pr.number === open.number)).toBe(true);
    expect(receive).toHaveBeenCalledWith(cached);
    const replacement = vi.fn();
    const closeReplacement = watches.subscribe(targets, replacement);
    close();
    expect(replacement).toHaveBeenCalledWith(cached);

    expect(await watches.refreshIfWatched(cached.target)).toEqual(merged);
    expect(read).toHaveBeenLastCalledWith(
      cached.target,
      expect.any(AbortSignal)
    );
    closeReplacement();
  } finally {
    vi.useRealTimers();
  }
});

it("backs off repeated failed lifecycle reads while replaying the original failure timestamp", async () => {
  vi.useFakeTimers();
  try {
    const read = vi
      .fn(async () => observation)
      .mockRejectedValueOnce(new Error("GitHub unreachable"))
      .mockResolvedValueOnce({ ...observation, state: null });
    const watches = new GitHubPullRequestWatches(read);
    const receive = vi.fn();
    const close = watches.subscribe([target], receive);
    const minute = 60_000;
    await vi.advanceTimersByTimeAsync(1);
    const first = receive.mock.lastCall![0];
    expect(first.observation).toBeNull();
    receive.mockClear();
    await vi.advanceTimersByTimeAsync(14 * minute);
    expect(read).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenLastCalledWith(first);

    await vi.advanceTimersByTimeAsync(minute);
    expect(read).toHaveBeenCalledTimes(2);
    expect(receive.mock.lastCall![0].observation.state).toBeNull();
    await vi.advanceTimersByTimeAsync(29 * minute);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(minute);
    expect(read).toHaveBeenCalledTimes(3);
    expect(receive.mock.lastCall![0].observation).toEqual(observation);

    // A successful read clears the backoff and restores the open cadence.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(4);
    close();
  } finally {
    vi.useRealTimers();
  }
});
