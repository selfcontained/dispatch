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
  const notify = vi.fn().mockResolvedValue(undefined);
  const listAgentIds = vi.fn().mockResolvedValue(["a", "b"]);
  const service = new PullRequestRefresher({
    pool: { query } as unknown as Pool,
    read,
    publish,
    notify,
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
      expect.objectContaining({ status: "Closed" })
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
      expect.objectContaining({ status: "Closed" })
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
