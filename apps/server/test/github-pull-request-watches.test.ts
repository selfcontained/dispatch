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
