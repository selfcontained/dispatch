import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentPullRequest, Block } from "@dispatch/shared";
import { PullRequestRefresher } from "../src/agents/pull-request-refresher.js";

function fixture(count = 1) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `post-${i}`,
    author_agent_id: "a",
    attachments: [
      { type: "pr", url: `https://github.com/a/b/pull/${i}`, title: `PR ${i}` },
    ],
  }));
  const tombstones: { agent_id: string; url: string }[] = [];
  const query = vi
    .fn()
    .mockImplementation(async (sql: string, params: string[]) => {
      if (sql.includes("INSERT INTO agent_pr_dismissals")) {
        tombstones.push({ agent_id: params[0], url: params[1] });
        return { rows: [] };
      }
      return {
        rows: sql.includes("FROM agent_pr_dismissals") ? tombstones : rows,
      };
    });
  const read = vi.fn(
    async (url: string, title: string): Promise<AgentPullRequest> => ({
      url,
      title,
      status: "Open",
    })
  );
  const publish = vi.fn();
  const notify = vi
    .fn<
      NonNullable<
        ConstructorParameters<typeof PullRequestRefresher>[0]["notify"]
      >
    >()
    .mockResolvedValue(undefined);
  const listAgentIds = vi.fn().mockResolvedValue(["a", "b"]);
  const service = new PullRequestRefresher({
    pool: { query } as unknown as Pool,
    read,
    publish,
    notify,
    notifyChecks: notify,
    listAgentIds,
    warn: vi.fn(),
  });
  return { rows, query, read, publish, notify, service, listAgentIds };
}
afterEach(() => vi.useRealTimers());
describe("server PR orchestration", () => {
  it("persists canonical agent-scoped dismissal through rediscovery and a reconstructed refresher", async () => {
    const f = fixture();
    f.rows.push({ ...f.rows[0], author_agent_id: "b" });
    await f.service.refresh();
    await f.service.dismiss("a", "https://github.com/A/B/pull/000#discussion");
    f.rows.push({ ...f.rows[0], id: "reposted" });
    await f.service.refresh();
    expect(f.service.get("a")).toEqual([]);
    expect(f.service.get("b")).toHaveLength(1);
    await f.service.stop();
    const restarted = new PullRequestRefresher({
      pool: { query: f.query } as unknown as Pool,
      listAgentIds: f.listAgentIds,
      read: f.read,
      publish: f.publish,
      warn: vi.fn(),
    });
    await restarted.refresh();
    expect(restarted.get("a")).toEqual([]);
    expect(restarted.get("b")).toHaveLength(1);
    await restarted.stop();
  });
  it("does not resurrect an association when an in-flight read finishes", async () => {
    const f = fixture();
    let finish!: (value: AgentPullRequest) => void;
    f.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const flight = f.service.refresh();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
    await f.service.dismiss("a", "https://github.com/a/b/pull/0");
    finish({
      url: "https://github.com/a/b/pull/0",
      title: "PR",
      status: "Merged",
    });
    await flight;
    expect(f.service.get("a")).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("cancels a notice still preparing after dismissal completes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.refresh();
    let resume!: () => void;
    const preparing = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const write = vi.fn();
    f.notify.mockImplementation(async (_id, _previous, _current, commit) => {
      await preparing;
      await commit(write);
    });
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: "Closed",
    }));
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    const refresh = f.service.refresh();
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalled());
    await f.service.dismiss("a", "https://github.com/a/b/pull/0");
    resume();
    await refresh;
    expect(write).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("waits for a notice already writing before acknowledging dismissal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.refresh();
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi.fn(() => writing);
    f.notify.mockImplementation(async (_id, _previous, _current, commit) => {
      await commit(write);
    });
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: "Closed",
    }));
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    const refresh = f.service.refresh();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    let acknowledged = false;
    const dismissal = f.service
      .dismiss("a", "https://github.com/a/b/pull/0")
      .then(() => {
        acknowledged = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await Promise.all([refresh, dismissal]);
    expect(acknowledged).toBe(true);
    expect(f.service.get("a")).toEqual([]);
    await f.service.stop();
  });
  it("leaves association visible on a failed durable write", async () => {
    const f = fixture();
    await f.service.refresh();
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(
      f.service.dismiss("a", "https://github.com/a/b/pull/0")
    ).rejects.toThrow("offline");
    expect(f.service.get("a")).toHaveLength(1);
    await f.service.stop();
  });
  it("announces observed transitions once to each existing owner, retaining baseline through errors", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rows.push({ ...f.rows[0], author_agent_id: "b" });
    f.rows.push({ ...f.rows[0], id: "duplicate" });
    let status: AgentPullRequest["status"] = "Draft";
    f.read.mockImplementation(async (url, title) => ({ url, title, status }));
    await f.service.refresh();
    expect(f.notify).not.toHaveBeenCalled();
    for (const next of [
      "Open",
      "Draft",
      "Open",
      "Unavailable",
      "Closed",
      "Open",
      "Merged",
    ] as const) {
      status = next;
      vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
      await Promise.all([f.service.refresh(), f.service.refresh()]);
    }
    expect(f.notify).toHaveBeenCalledTimes(12);
    expect(f.notify.mock.calls.map(([id]) => id)).toEqual(
      Array(6).fill(["a", "b"]).flat()
    );
    expect(f.notify).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ status: "Open" }),
      expect.objectContaining({ status: "Closed" }),
      expect.any(Function)
    );
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await f.service.refresh();
    expect(f.notify).toHaveBeenCalledTimes(12);
  });
  it("does not announce discovery, failed first lookup, or reconstructed restart baselines", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("API unavailable"));
    await f.service.refresh();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await f.service.refresh();
    expect(f.notify).not.toHaveBeenCalled();
    const restarted = fixture();
    restarted.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: "Closed",
    }));
    await restarted.service.refresh();
    expect(restarted.notify).not.toHaveBeenCalled();
  });
  it("publishes cache updates despite recipient failures and ignores unchanged polls", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.refresh();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await f.service.refresh();
    expect(f.notify).not.toHaveBeenCalled();
    f.rows.push({ ...f.rows[0], author_agent_id: "b" });
    await f.service.refresh();
    f.notify.mockImplementation(async (id) => {
      if (id === "a") throw new Error("recipient unavailable");
    });
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: "Closed",
    }));
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await f.service.refresh();
    expect(f.service.get("a")[0].status).toBe("Closed");
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledWith(
      "b",
      expect.anything(),
      expect.objectContaining({ status: "Closed" }),
      expect.any(Function)
    );
  });
  it("deduplicates across agents and ignores ordinary links with PR-looking URLs", async () => {
    const f = fixture();
    f.rows.push({ ...f.rows[0], author_agent_id: "b" });
    f.rows.push({
      id: "ordinary",
      author_agent_id: "a",
      attachments: [
        {
          type: "link",
          url: "https://github.com/a/b/pull/99",
          title: "Not an explicit PR",
        },
      ],
    });
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.service.get("a")).toHaveLength(1);
    expect(f.service.get("b")).toEqual(f.service.get("a"));
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.pull_requests_changed",
        agentId: "a",
      })
    );
    const events = f.publish.mock.calls.length;
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(events);
  });
  it("caps global concurrency at two and lookups at twelve per rolling minute, with pending overflow", async () => {
    vi.useFakeTimers();
    const f = fixture(20);
    let active = 0,
      max = 0;
    f.read.mockImplementation(async (url, title) => {
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return { url, title, status: "Open" };
    });
    await Promise.all([f.service.refresh(), f.service.refresh()]);
    expect(max).toBe(2);
    expect(f.read).toHaveBeenCalledTimes(12);
    expect(
      f.service.get("a").filter((pr) => pr.status === "Pending")
    ).toHaveLength(8);
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(12);
    vi.setSystemTime(Date.now() + 60_001);
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(20);
  });
  it("refreshes open PRs every five minutes, backs off failures, and stops polling merged PRs", async () => {
    vi.useFakeTimers();
    const f = fixture(3);
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: url.endsWith("/0")
        ? "Open"
        : url.endsWith("/1")
          ? "Merged"
          : "Unavailable",
    }));
    await f.service.refresh();
    vi.setSystemTime(Date.now() + 60_001);
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(4);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(6);
    expect(
      f.read.mock.calls.filter(([url]) => url.endsWith("/1"))
    ).toHaveLength(1);
  });
  it("clears deleted agents and removed PR links and shuts down its timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.start();
    await vi.advanceTimersByTimeAsync(201);
    expect(f.service.get("a")).toHaveLength(1);
    f.rows.splice(0);
    await f.service.refresh();
    expect(f.service.get("a")).toEqual([]);
    expect(f.publish).toHaveBeenLastCalledWith({
      type: "agent.pull_requests_changed",
      agentId: "a",
      pullRequests: [],
    });
    await f.service.stop();
    const calls = f.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.query).toHaveBeenCalledTimes(calls);
  });
  it("does not wake every minute, and parks entirely when there are no PRs or only merged PRs", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.start();
    await vi.advanceTimersByTimeAsync(201);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(f.query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(f.read).toHaveBeenCalledTimes(2);
    await f.service.stop();
    for (const count of [0, 1]) {
      const parked = fixture(count);
      parked.read.mockImplementation(async (url, title) => ({
        url,
        title,
        status: "Merged",
      }));
      parked.service.start();
      await vi.advanceTimersByTimeAsync(201);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(parked.query).toHaveBeenCalledTimes(2);
      await parked.service.stop();
    }
  });
  it("keeps unchanged open and draft PRs on a five-minute cadence without activity hints", async () => {
    vi.useFakeTimers();
    const f = fixture(2);
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: url.endsWith("/0") ? "Open" : "Draft",
    }));
    await f.service.refresh();
    for (let cycle = 1; cycle <= 25; cycle++) {
      vi.setSystemTime(Date.now() + 5 * 60_000 - 1);
      await f.service.refresh();
      expect(f.read).toHaveBeenCalledTimes(cycle * 2);
      vi.setSystemTime(Date.now() + 1);
      await f.service.refresh();
      expect(f.read).toHaveBeenCalledTimes((cycle + 1) * 2);
    }
  });
  it("discovers added PR attachments on an existing post but ignores repeated unchanged posts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.refresh();
    const block = {
      id: f.rows[0].id,
      attachments: f.rows[0].attachments,
    } as unknown as Block;
    f.service.observeBlock(block);
    await vi.advanceTimersByTimeAsync(201);
    expect(f.query).toHaveBeenCalledTimes(2);
    f.rows[0].attachments.push({
      type: "pr",
      url: "https://github.com/a/b/pull/99",
      title: "New PR",
    });
    f.service.observeBlock(block);
    await vi.advanceTimersByTimeAsync(201);
    expect(f.service.get("a")).toHaveLength(2);
    expect(f.read).toHaveBeenCalledTimes(2);
    await f.service.stop();
  });
  it("backs off inventory errors instead of repeatedly waking for an overdue PR", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.start();
    await vi.advanceTimersByTimeAsync(201);
    f.query.mockRejectedValue(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.query).toHaveBeenCalledTimes(3);
    await f.service.stop();
  });
});

it("publishes same-head CI transitions and new heads without lifecycle notices", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const ci = (
    headSha: string,
    pending: number
  ): NonNullable<AgentPullRequest["ci"]> => ({
    headSha,
    checkedAt: new Date().toISOString(),
    availability: "available",
    summary: {
      status: pending ? "pending" : "passing",
      total: 1,
      passed: pending ? 0 : 1,
      failed: 0,
      pending,
      skipped: 0,
    },
    checks: [],
  });
  f.read.mockImplementation(async (url, title) => ({
    url,
    title,
    status: "Draft",
    ci: ci("first", 1),
  }));
  await f.service.refresh();
  f.read.mockImplementation(async (url, title) => ({
    url,
    title,
    status: "Draft",
    ci: ci("first", 0),
  }));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await f.service.refresh();
  expect(f.service.get("a")[0].ci?.summary.status).toBe("passing");
  f.read.mockImplementation(async (url, title) => ({
    url,
    title,
    status: "Draft",
    ci: ci("second", 1),
  }));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await f.service.refresh();
  expect(f.service.get("a")[0].ci?.headSha).toBe("second");
  expect(f.service.get("a")[0].ci?.summary.status).toBe("pending");
  expect(f.notify).not.toHaveBeenCalled();
  await f.service.stop();
});

it.each(["Open", "Draft"] as const)(
  "keeps %s lifecycle polling timely when CI stays unavailable",
  async (status) => {
    vi.useFakeTimers();
    const f = fixture();
    const ci: NonNullable<AgentPullRequest["ci"]> = {
      checkedAt: new Date().toISOString(),
      headSha: "abc",
      availability: "unavailable",
      summary: {
        status: "none",
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
      },
      checks: [],
    };
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status,
      ci,
    }));
    await f.service.refresh();
    for (let interval = 0; interval < 4; interval++) {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await f.service.refresh();
      expect(f.read).toHaveBeenCalledTimes(interval + 2);
    }
    expect(f.notify).not.toHaveBeenCalled();
    f.read.mockImplementation(async (url, title) => ({
      url,
      title,
      status: "Merged",
      ci,
    }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await f.service.refresh();
    expect(f.service.get("a")[0].status).toBe("Merged");
    expect(f.notify).toHaveBeenCalledTimes(1);
    const calls = f.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await f.service.refresh();
    expect(f.read).toHaveBeenCalledTimes(calls);
    await f.service.stop();
  }
);

it("silently baselines checks, coalesces for every owner, preserves baseline across unavailable reads, and honors dismissal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.rows.push({ ...f.rows[0], author_agent_id: "b" });
  const { mapPullRequestChecks } =
    await import("../src/agents/pull-request-reader.js");
  let result = "";
  let unavailable = false;
  f.read.mockImplementation(async (url, title) => ({
    url,
    title,
    status: "Open",
    ci: mapPullRequestChecks(
      "head",
      unavailable
        ? undefined
        : [
            {
              __typename: "CheckRun",
              name: "tests",
              status: result ? "COMPLETED" : "IN_PROGRESS",
              conclusion: result,
            },
          ]
    ),
  }));
  await f.service.refresh();
  expect(f.notify).not.toHaveBeenCalled();
  const poll = async () => {
    vi.setSystemTime(Date.now() + 301000);
    await f.service.refresh();
  };
  result = "SUCCESS";
  await poll();
  expect(f.notify.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  await poll();
  unavailable = true;
  await poll();
  unavailable = false;
  await poll();
  expect(f.notify).toHaveBeenCalledTimes(2);
  await f.service.dismiss("a", f.rows[0].attachments[0].url);
  result = "";
  await poll();
  result = "FAILURE";
  await poll();
  expect(f.notify).toHaveBeenCalledTimes(3);
  expect(f.notify.mock.calls[2][0]).toBe("b");
  await f.service.stop();
});

it("refreshes only an owned PR and preserves observations on failure", async () => {
  const f = fixture(2);
  await f.service.refresh();
  f.read.mockClear();
  await expect(
    f.service.refreshOne("b", f.service.get("a")[0].url)
  ).rejects.toThrow("tracked");
  expect(f.read).not.toHaveBeenCalled();
  const url = f.service.get("a")[0].url;
  await f.service.refreshOne("a", url);
  expect(f.read.mock.calls.map(([target]) => target)).toEqual([url]);
  const before = f.service.get("a");
  f.read.mockRejectedValue(new Error("offline"));
  await expect(f.service.refreshOne("a", url)).rejects.toThrow(
    "authentication"
  );
  expect(f.service.get("a")).toEqual(before);
  await f.service.dismiss("a", url);
  f.read.mockClear();
  await expect(f.service.refreshOne("a", url)).rejects.toThrow("tracked");
  expect(f.read).not.toHaveBeenCalled();
  await f.service.stop();
});

it("attaches merge-risk assessments to observed heads and carries them while the head is unchanged", async () => {
  const f = fixture();
  const ci: NonNullable<AgentPullRequest["ci"]> = {
    checkedAt: "2026-11-09T00:00:00Z",
    headSha: "head1",
    availability: "available",
    summary: {
      status: "passing",
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
    },
    checks: [],
  };
  f.read.mockImplementation(async (url, title) => ({
    url,
    title,
    status: "Open",
    ci,
  }));
  const assess = vi.fn(
    async (): Promise<AgentPullRequest["mergeRisk"]> => ({
      verdict: "routine",
      changeRisk: 1,
      changeRiskLabel: "moderate",
      reviewAdequate: 0.9,
      descriptionMatches: 0.9,
      newSurface: 0.1,
      routineProbability: 0.9,
      humanReviewProbability: 0.1,
      confidence: 0.9,
      status: "ok",
      promptVersion: "v1",
      headSha: "head1",
      assessedAt: "2026-11-09T00:00:01Z",
    })
  );
  const service = new PullRequestRefresher({
    pool: { query: f.query } as unknown as Pool,
    read: f.read,
    publish: f.publish,
    listAgentIds: f.listAgentIds,
    assess,
    warn: vi.fn(),
  });
  await service.refresh();
  expect(assess).toHaveBeenCalledWith(
    "https://github.com/a/b/pull/0",
    expect.objectContaining({ status: "Open" }),
    ["a"],
    expect.any(Function)
  );
  expect(service.get("a")[0]!.mergeRisk?.verdict).toBe("routine");
  // A later observation of the same head without a fresh assessment keeps the verdict;
  // an assessment failure is logged, not fatal.
  assess.mockRejectedValue(new Error("provider down"));
  await service.refreshOne("a", "https://github.com/a/b/pull/0");
  // A failed assessor cannot establish that historical data is still enabled.
  expect(service.get("a")[0]!.mergeRisk).toBeUndefined();
  await service.stop();
});

it("refreshes tracked PRs promptly when review findings resolve, coalescing duplicate publications", async () => {
  const f = fixture();
  await f.service.refresh();
  const review = {
    id: "review-1",
    kind: "review",
    toAgentId: "a",
    attachments: [],
    blocks: [
      {
        id: "finding-1",
        kind: "finding",
        attachments: [],
        state: { status: "open" },
      },
    ],
  } as unknown as Block;
  f.service.observeBlock(review);
  await f.service.refresh();
  const before = f.read.mock.calls.length;
  const resolved = {
    ...review,
    blocks: [
      {
        ...review.blocks![0],
        state: { status: "resolved", resolution: "fixed" },
      },
    ],
  };
  f.service.observeBlock(resolved);
  await f.service.refresh();
  expect(f.read).toHaveBeenCalledTimes(before + 1);
  f.service.observeBlock(resolved);
  await f.service.refresh();
  expect(f.read).toHaveBeenCalledTimes(before + 1);
  await f.service.stop();
});

it("clears cached risk immediately on disable and suppresses in-flight progress", async () => {
  const f = fixture();
  // Exercise the same callback contract with an isolated refresher.
  const service = new PullRequestRefresher({
    pool: { query: f.query } as unknown as Pool,
    listAgentIds: f.listAgentIds,
    read: f.read,
    publish: f.publish,
    warn: vi.fn(),
    assess: async (_url, _value, _owners, progress) => {
      service.hideRisk();
      progress?.({ verdict: "routine" } as never);
      return { verdict: "routine" } as never;
    },
  });
  await service.refresh();
  expect(service.get("a")[0]!.mergeRisk).toBeUndefined();
  expect(
    f.publish.mock.calls
      .flatMap(([event]) => event.pullRequests ?? [])
      .every((pr) => !pr.mergeRisk)
  ).toBe(true);
  await service.stop();
});

it.each([false, true])(
  "preserves review invalidation during an assessment (initial refresh: %s)",
  async (initial) => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pause = initial;
    const service = new PullRequestRefresher({
      pool: { query: f.query } as unknown as Pool,
      listAgentIds: f.listAgentIds,
      read: f.read,
      publish: f.publish,
      warn: vi.fn(),
      assess: async () => {
        if (pause) {
          pause = false;
          entered();
          await paused;
        }
        return { verdict: "routine" } as never;
      },
    });
    if (!initial) {
      await service.refresh();
      pause = true;
    }
    const flight = initial
      ? service.refresh()
      : service.refreshOne("a", "https://github.com/a/b/pull/0");
    await started;
    service.observeBlock({
      id: "review-racing",
      kind: "review",
      toAgentId: "a",
      attachments: [],
      blocks: [
        {
          id: "finding-racing",
          kind: "finding",
          attachments: [],
          state: { status: "resolved", resolution: "fixed" },
        },
      ],
    } as unknown as Block);
    release();
    await flight;
    expect(service.get("a")[0]!.mergeRisk).toBeUndefined();
    const before = f.read.mock.calls.length;
    await service.refresh();
    expect(f.read).toHaveBeenCalledTimes(before + 1);
    expect(service.get("a")[0]!.mergeRisk?.verdict).toBe("routine");
    await service.stop();
  }
);
