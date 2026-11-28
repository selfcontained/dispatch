import { checkChanges } from "./pull-request-check-notice.js";
import type { AgentPullRequest, Block } from "@dispatch/shared";
import { PULL_REQUEST_ACTIVE_REFRESH_MS } from "@dispatch/runner-protocol";
import type { Pool } from "pg";
import type { PublishUiEvent } from "../server/ui-events.js";
import { githubPullRequestUrl } from "./pull-request-reader.js";

export type CommitPullRequestNotice = <T>(
  write: () => Promise<T>
) => Promise<T | undefined>;

type Options = {
  pool: Pool;
  listAgents: () => Promise<{ id: string; runnerId: string | null }[]>;
  publish: PublishUiEvent;
  /** The tracking agent's runner reads the PR; `runnerId` is null for the local runner. */
  read: (
    url: string,
    title: string,
    runnerId: string | null
  ) => Promise<AgentPullRequest>;
  notify?: (
    agentId: string,
    previous: AgentPullRequest,
    current: AgentPullRequest,
    commit: CommitPullRequestNotice
  ) => Promise<void>;
  notifyChecks?: Options["notify"];
  notifyRisk?: Options["notify"];
  /** Merge-risk recommendation for an observed head; owners are the agents tracking the PR. */
  assess?: (
    url: string,
    value: AgentPullRequest,
    ownerAgentIds: string[],
    onProgress?: (risk: NonNullable<AgentPullRequest["mergeRisk"]>) => void,
    runnerId?: string | null
  ) => Promise<AgentPullRequest["mergeRisk"]>;
  warn: (error: unknown) => void;
};

/** One server-owned queue, independent of browser count and mounted rows. */
export class PullRequestRefresher {
  private noticeWrites = new Map<string, Set<Promise<unknown>>>();
  private dismissed = new Map<string, Set<string>>();
  private isDismissed(agentId: string, url: string) {
    return this.dismissed.get(agentId)?.has(url) ?? false;
  }
  async dismiss(agentId: string, url: string) {
    const key = githubPullRequestUrl(url) ?? url;
    await this.options.pool.query(
      `INSERT INTO agent_pr_dismissals (agent_id, url) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [agentId, key]
    );
    const own = this.dismissed.get(agentId) ?? new Set<string>();
    own.add(key);
    this.dismissed.set(agentId, own);
    // A notice that already crossed the write boundary must finish before
    // dismissal succeeds. Earlier async preparation will fail its guard.
    await Promise.allSettled([
      ...(this.noticeWrites.get(`${agentId}:${key}`) ?? []),
    ]);
    const next = this.get(agentId).filter((pr) => pr.url !== key);
    this.snapshots.set(agentId, next);
    this.options.publish({
      type: "agent.pull_requests_changed",
      agentId,
      pullRequests: next,
    });
    this.signal();
  }
  private snapshots = new Map<string, AgentPullRequest[]>();
  private urls = new Map<
    string,
    {
      value: AgentPullRequest;
      lifecycle?: AgentPullRequest;
      checks?: AgentPullRequest;
      due: number;
      failures: number;
    }
  >();
  private attempts: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private inventoryRetryAt = Infinity;
  private pendingUrls = new Set<string>();
  private resourceBlocks = new Map<string, string>();
  private pending?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private stopped = false;
  private dirty = false;
  constructor(private options: Options) {}
  get(agentId: string): AgentPullRequest[] {
    return this.snapshots.get(agentId) ?? [];
  }
  private riskHidden = false;
  allowRisk() {
    this.riskHidden = false;
  }
  /** Remove cached assessments immediately without scheduling provider work. */
  hideRisk() {
    this.riskHidden = true;
    const hide = (pr: AgentPullRequest): AgentPullRequest => ({
      ...pr,
      mergeRisk: undefined,
    });
    for (const entry of this.urls.values()) {
      entry.value = hide(entry.value);
      if (entry.lifecycle) entry.lifecycle = hide(entry.lifecycle);
      if (entry.checks) entry.checks = hide(entry.checks);
    }
    for (const [agentId, prs] of this.snapshots) {
      const pullRequests = prs.map(hide);
      this.snapshots.set(agentId, pullRequests);
      this.options.publish({
        type: "agent.pull_requests_changed",
        agentId,
        pullRequests,
      });
    }
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.signal();
  }
  private placements = new Map<string, string | null>();
  private trackingKey(agentId: string, url: string) {
    return JSON.stringify([this.placements.get(agentId), url]);
  }
  private readonly runnerRevision = new Map<string, number>();
  /** A changed connection or GitHub account cannot reuse the previous peer's observations. */
  invalidateRunner(runnerId: string) {
    const owners = [...this.placements].filter(([, id]) => id === runnerId);
    if (!owners.length) return;
    this.runnerRevision.set(
      runnerId,
      (this.runnerRevision.get(runnerId) ?? 0) + 1
    );
    for (const [id] of owners) {
      const current = this.get(id);
      if (!current.length) continue;
      const pending = current.map(({ url }) => {
        this.urls.delete(this.trackingKey(id, url));
        return { url, title: url, status: "Pending" as const };
      });
      this.snapshots.set(id, pending);
      this.options.publish({
        type: "agent.pull_requests_changed",
        agentId: id,
        pullRequests: pending,
      });
    }
    this.signal();
  }

  private reviewGeneration = new Map<string, number>();
  private reviewStates = new Map<string, string>();
  /** Explicit PR posts and edits to previously tracked posts reconcile inventory. */
  observeBlock(block: Block) {
    if (block.kind === "text" && block.data?.pullRequestTransition) return;
    let changed = false;
    const visit = (current: Block) => {
      if (
        current.kind === "review" &&
        current.toAgentId &&
        current.blocks?.length
      ) {
        const signature = JSON.stringify(
          current.blocks
            .filter((b) => b.kind === "finding")
            .map((b) => [b.id, b.state?.status, b.state?.resolution])
        );
        if (this.reviewStates.get(current.id) !== signature) {
          this.reviewStates.set(current.id, signature);
          // Review updates otherwise reconcile inventory but leave the five-minute
          // GitHub freshness deadline intact. Reuse the existing bounded queue.
          for (const pr of this.get(current.toAgentId)) {
            const key = this.trackingKey(current.toAgentId, pr.url);
            const entry = this.urls.get(key);
            this.reviewGeneration.set(
              key,
              (this.reviewGeneration.get(key) ?? 0) + 1
            );
            if (entry) entry.due = 0;
          }
          changed = true;
        }
      }
      const refs = current.attachments.filter((a) => a.type === "pr");
      if (refs.length) {
        const signature = JSON.stringify(refs);
        if (this.resourceBlocks.get(current.id) !== signature) changed = true;
        this.resourceBlocks.set(current.id, signature);
      } else if (this.resourceBlocks.delete(current.id)) changed = true;
      for (const child of current.blocks ?? []) visit(child);
    };
    visit(block);
    if (changed) this.signal();
  }
  /** Sleep until actual work is due; there is no periodic scan. */
  private scheduleNext() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.stopped || this.flight || this.pending) return;
    const now = Date.now();
    this.attempts = this.attempts.filter((at) => at > now - 60_000);
    let due = this.pendingUrls.size ? now : Infinity;
    for (const entry of this.urls.values()) due = Math.min(due, entry.due);
    if (this.attempts.length >= 12)
      due = Math.max(due, this.attempts[0] + 60_001);
    if (Number.isFinite(this.inventoryRetryAt)) due = this.inventoryRetryAt;
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.signal();
      },
      Math.max(1_000, due - now)
    );
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    this.started = false;
    clearTimeout(this.timer);
    clearTimeout(this.pending);
    this.timer = undefined;
    this.pending = undefined;
    await this.flight;
  }
  /** Coalesce inventory events without bypassing lookup freshness or rate limits. */
  signal() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = true;
    if (this.pending || this.flight) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.refresh();
    }, 200);
    this.pending.unref();
  }
  refresh(): Promise<void> {
    if (this.flight) return this.flight;
    this.dirty = false;
    this.flight = this.reconcile()
      .catch((error) => {
        this.inventoryRetryAt = Date.now() + 15 * 60_000;
        this.options.warn(error);
      })
      .finally(() => {
        this.flight = undefined;
        if (this.dirty) this.signal();
        else this.scheduleNext();
      });
    return this.flight;
  }
  async refreshOne(agentId: string, rawUrl: string) {
    const url = githubPullRequestUrl(rawUrl);
    if (
      !url ||
      !this.get(agentId).some((pr) => pr.url === url) ||
      this.isDismissed(agentId, url)
    )
      throw new Error("PR is no longer tracked by this agent.");
    // Serialize with the shared queue so old observations cannot overwrite new ones.
    if (this.flight) await this.flight;
    if (this.flight) throw new Error("PR refresh is busy. Please try again.");
    const flight = this.reconcile({ agentId, url });
    this.flight = flight;
    try {
      await flight;
      return this.get(agentId);
    } finally {
      this.flight = undefined;
      if (this.dirty) this.signal();
      else this.scheduleNext();
    }
  }
  private async reconcile(target?: { agentId: string; url: string }) {
    const placements = await this.options.listAgents();
    this.placements = new Map(
      placements.map(({ id, runnerId }) => [id, runnerId])
    );
    const ids = [...this.placements.keys()];
    const tombstones = await this.options.pool.query<{
      agent_id: string;
      url: string;
    }>(
      "SELECT agent_id, url FROM agent_pr_dismissals WHERE agent_id = ANY($1::text[])",
      [ids]
    );
    for (const row of tombstones.rows) {
      const own = this.dismissed.get(row.agent_id) ?? new Set<string>();
      own.add(row.url);
      this.dismissed.set(row.agent_id, own);
    }
    const { rows } = await this.options.pool.query<{
      id: string;
      author_agent_id: string;
      attachments: Block["attachments"];
    }>(
      `SELECT id, author_agent_id, attachments FROM blocks
       WHERE author_agent_id = ANY($1::text[]) AND attachments @> '[{"type":"pr"}]'::jsonb
       AND NOT (COALESCE(data, '{}'::jsonb) ? 'pullRequestTransition')
       ORDER BY created_at DESC, id DESC`,
      [ids]
    );
    this.inventoryRetryAt = Infinity;
    this.resourceBlocks = new Map(
      rows.map((row) => [
        row.id,
        JSON.stringify(row.attachments.filter((a) => a.type === "pr")),
      ])
    );
    const agents = new Map<string, Set<string>>();
    const links = new Map<
      string,
      { url: string; title: string; runnerId: string | null }
    >();
    for (const row of rows)
      for (const attachment of row.attachments) {
        if (attachment.type !== "pr") continue;
        let url: URL;
        try {
          url = new URL(attachment.url);
        } catch {
          continue;
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
        const canonical =
          githubPullRequestUrl(attachment.url) ?? attachment.url;
        const runnerId = this.placements.get(row.author_agent_id);
        if (
          runnerId === undefined ||
          this.isDismissed(row.author_agent_id, canonical)
        )
          continue;
        const key = this.trackingKey(row.author_agent_id, canonical);
        if (!links.has(key))
          links.set(key, {
            url: canonical,
            title: attachment.title ?? canonical,
            runnerId,
          });
        const own = agents.get(row.author_agent_id) ?? new Set<string>();
        own.add(key);
        agents.set(row.author_agent_id, own);
      }
    if (this.stopped) return;
    const publishSnapshots = () => {
      if (this.stopped) return;
      for (const id of new Set([...ids, ...this.snapshots.keys()])) {
        const next = [...(agents.get(id) ?? [])].flatMap((key) => {
          const { url, title } = links.get(key)!;
          if (this.isDismissed(id, url)) return [];
          return (
            this.urls.get(key)?.value ?? {
              url,
              title,
              status: "Pending" as const,
            }
          );
        });
        if (JSON.stringify(this.get(id)) !== JSON.stringify(next)) {
          this.snapshots.set(id, next);
          this.options.publish({
            type: "agent.pull_requests_changed",
            agentId: id,
            pullRequests: next,
          });
        }
        if (!ids.includes(id)) this.snapshots.delete(id);
      }
    };
    const existingOwners = new Map(
      [...this.snapshots].map(([id, prs]) => [
        id,
        new Set(prs.map((pr) => pr.url)),
      ])
    );
    const notices: Array<() => Promise<void>> = [];
    publishSnapshots();
    const now = Date.now();
    const dueReads: typeof links = new Map();
    for (const [key, link] of links) {
      if (
        target
          ? key === this.trackingKey(target.agentId, target.url)
          : (this.urls.get(key)?.due ?? 0) <= now
      )
        dueReads.set(key, link);
    }
    if (!target) this.pendingUrls = new Set(dueReads.keys());
    this.attempts = this.attempts.filter((at) => at > now - 60_000);
    if (target) {
      if (
        !agents
          .get(target.agentId)
          ?.has(this.trackingKey(target.agentId, target.url)) ||
        this.isDismissed(target.agentId, target.url)
      )
        throw new Error("PR is no longer tracked by this agent.");
      if (this.attempts.length >= 12)
        throw new Error("PR refresh budget reached. Please retry in a minute.");
    }
    const queue = [...dueReads]
      .sort(
        ([a], [b]) =>
          (this.urls.get(a)?.due ?? 0) - (this.urls.get(b)?.due ?? 0)
      )
      .slice(0, Math.max(0, 12 - this.attempts.length));
    // Global rolling budget and two workers, regardless of clients or agents.
    await Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (queue.length && !this.stopped) {
          const [key, { url, title, runnerId }] = queue.shift()!;
          const reviewGeneration = this.reviewGeneration.get(key) ?? 0;
          const revision = this.runnerRevision.get(runnerId ?? "");
          const peerChanged = () =>
            this.runnerRevision.get(runnerId ?? "") !== revision;
          let value: AgentPullRequest;
          this.attempts.push(Date.now());
          try {
            value = await this.options.read(url, title, runnerId);
          } catch {
            value = { url, title, status: "Unavailable" };
          }
          if (peerChanged()) {
            if (target)
              throw new Error(
                "Runner connection or account changed. Please retry."
              );
            continue;
          }
          if (
            target &&
            (value.status === "Unavailable" ||
              value.ci?.availability === "unavailable")
          )
            throw new Error(
              "Could not refresh PR. Check GitHub authentication and try again."
            );
          const previous = this.urls.get(key);
          if (this.options.assess) {
            const owners = [...agents]
              .filter(([, urls]) => urls.has(key))
              .map(([id]) => id);
            try {
              const mergeRisk = await this.options.assess(
                url,
                value,
                owners,
                (risk) => {
                  if (
                    this.stopped ||
                    peerChanged() ||
                    this.riskHidden ||
                    (this.reviewGeneration.get(key) ?? 0) !== reviewGeneration
                  )
                    return;
                  for (const id of owners) {
                    if (this.isDismissed(id, url)) continue;
                    const current = { ...value, mergeRisk: risk };
                    const next = [
                      ...this.get(id).filter((pr) => pr.url !== url),
                      current,
                    ];
                    this.snapshots.set(id, next);
                    this.options.publish({
                      type: "agent.pull_requests_changed",
                      agentId: id,
                      pullRequests: next,
                    });
                  }
                },
                runnerId
              );
              if (
                mergeRisk &&
                (!this.riskHidden || mergeRisk.displayState === "disabled")
              )
                value = { ...value, mergeRisk };
            } catch (error) {
              this.options.warn(error);
            }
          }
          if (peerChanged()) {
            if (target)
              throw new Error(
                "Runner connection or account changed. Please retry."
              );
            continue;
          }
          if (
            !this.options.assess &&
            !value.mergeRisk &&
            previous?.value.mergeRisk &&
            previous.value.mergeRisk.headSha === value.ci?.headSha
          )
            value = { ...value, mergeRisk: previous.value.mergeRisk };
          // A transport failure must not discard a previously observed lifecycle,
          // nor keep displaying old-head checks as current.
          // CI-only errors must not delay healthy lifecycle reads/notices.
          const unavailable = value.status === "Unavailable";
          if (unavailable && previous?.lifecycle) {
            value = {
              ...previous.lifecycle,
              mergeRisk: value.mergeRisk,
              ci: {
                checkedAt: new Date().toISOString(),
                headSha: "",
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
              },
            };
          }
          const failures = unavailable ? (previous?.failures ?? 0) + 1 : 0;
          const delay =
            value.status === "Merged"
              ? Infinity
              : failures
                ? Math.min(4 * 60 * 60_000, 15 * 60_000 * 2 ** (failures - 1))
                : value.status === "Closed"
                  ? 6 * 60 * 60_000
                  : PULL_REQUEST_ACTIVE_REFRESH_MS;
          const lifecycle = ["Draft", "Open", "Closed", "Merged"].includes(
            value.status
          )
            ? value
            : previous?.lifecycle;
          const lifecycleChanged =
            lifecycle === value &&
            previous?.lifecycle &&
            previous.lifecycle.status !== value.status;
          const checksChanged =
            previous &&
            checkChanges(previous.checks ?? previous.value, value).length > 0;
          const reviewChanged =
            (this.reviewGeneration.get(key) ?? 0) !== reviewGeneration;
          for (const notify of [
            lifecycleChanged ? this.options.notify : undefined,
            checksChanged ? this.options.notifyChecks : undefined,
            !reviewChanged && !this.riskHidden
              ? this.options.notifyRisk
              : undefined,
          ]) {
            if (!notify) continue;
            for (const [id, urls] of agents) {
              if (
                urls.has(key) &&
                (notify === this.options.notifyRisk ||
                  existingOwners.get(id)?.has(url)) &&
                notify
              ) {
                const before =
                  notify === this.options.notifyChecks
                    ? (previous!.checks ?? previous!.value)
                    : (previous?.lifecycle ?? value);
                notices.push(async () => {
                  if (!peerChanged() && !this.isDismissed(id, url))
                    await notify(id, before, value, async (write) => {
                      if (
                        peerChanged() ||
                        this.isDismissed(id, url) ||
                        (notify === this.options.notifyRisk &&
                          (this.riskHidden ||
                            (this.reviewGeneration.get(key) ?? 0) !==
                              reviewGeneration))
                      )
                        return undefined;
                      const noticeKey = `${id}:${url}`;
                      const writes =
                        this.noticeWrites.get(noticeKey) ??
                        new Set<Promise<unknown>>();
                      const flight = Promise.resolve().then(write);
                      writes.add(flight);
                      this.noticeWrites.set(noticeKey, writes);
                      try {
                        return await flight;
                      } finally {
                        writes.delete(flight);
                        if (!writes.size) this.noticeWrites.delete(noticeKey);
                      }
                    });
                });
              }
            }
          }
          // A result based on older review evidence cannot be current. Keep the
          // URL due so the dirty follow-up consumes the new evidence, even on
          // its first refresh when no cache entry existed at invalidation time.
          if (reviewChanged) value = { ...value, mergeRisk: undefined };
          this.urls.set(key, {
            value,
            lifecycle,
            checks:
              value.ci?.availability === "available" ? value : previous?.checks,
            failures,
            due: reviewChanged ? 0 : Date.now() + delay,
          });
          this.pendingUrls.delete(key);
        }
      })
    );
    if (this.stopped) return;
    for (const url of this.urls.keys())
      if (!links.has(url)) {
        this.urls.delete(url);
        this.reviewGeneration.delete(url);
      }
    publishSnapshots();
    await Promise.all(
      notices.map(async (notify) => {
        try {
          await notify();
        } catch (error) {
          this.options.warn(error);
        }
      })
    );
  }
}
