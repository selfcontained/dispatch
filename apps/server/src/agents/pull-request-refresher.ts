import type { AgentPullRequest, Block } from "@dispatch/shared";
import type { Pool } from "pg";
import type { PublishUiEvent } from "../server/ui-events.js";
import {
  createPullRequestReader,
  githubPullRequestUrl,
} from "./pull-request-reader.js";

type Options = {
  pool: Pool;
  listAgentIds: () => Promise<string[]>;
  publish: PublishUiEvent;
  read?: (url: string, title: string) => Promise<AgentPullRequest>;
  warn: (error: unknown) => void;
};

/** One server-owned queue, independent of browser count and mounted rows. */
export class PullRequestRefresher {
  private snapshots = new Map<string, AgentPullRequest[]>();
  private urls = new Map<
    string,
    {
      value: AgentPullRequest;
      due: number;
      failures: number;
      checkedAt: number;
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
  private read: NonNullable<Options["read"]>;
  constructor(private options: Options) {
    this.read = options.read ?? createPullRequestReader();
  }
  get(agentId: string): AgentPullRequest[] {
    return this.snapshots.get(agentId) ?? [];
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.signal();
  }
  /** Explicit PR posts and edits to previously tracked posts reconcile inventory. */
  observeBlock(block: Block) {
    let changed = false;
    const visit = (current: Block) => {
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
  private async reconcile() {
    const ids = await this.options.listAgentIds();
    const { rows } = await this.options.pool.query<{
      id: string;
      author_agent_id: string;
      attachments: Block["attachments"];
    }>(
      `SELECT id, author_agent_id, attachments FROM blocks
       WHERE author_agent_id = ANY($1::text[]) AND attachments @> '[{"type":"pr"}]'::jsonb
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
    const links = new Map<string, string>();
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
        const key = githubPullRequestUrl(attachment.url) ?? attachment.url;
        if (!links.has(key)) links.set(key, attachment.title ?? key);
        const own = agents.get(row.author_agent_id) ?? new Set<string>();
        own.add(key);
        agents.set(row.author_agent_id, own);
      }
    const publishSnapshots = () => {
      if (this.stopped) return;
      for (const id of new Set([...ids, ...this.snapshots.keys()])) {
        const next = [...(agents.get(id) ?? [])].flatMap(
          (url) =>
            this.urls.get(url)?.value ?? {
              url,
              title: links.get(url) ?? url,
              status: "Pending" as const,
            }
        );
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
    publishSnapshots();
    this.pendingUrls = new Set(
      [...links.keys()].filter((url) => !this.urls.has(url))
    );
    const now = Date.now();
    this.attempts = this.attempts.filter((at) => at > now - 60_000);
    const queue = [...links]
      .filter(([url]) => (this.urls.get(url)?.due ?? 0) <= now)
      .sort(
        ([a], [b]) =>
          (this.urls.get(a)?.due ?? 0) - (this.urls.get(b)?.due ?? 0)
      )
      .slice(0, Math.max(0, 12 - this.attempts.length));
    // Global rolling budget and two workers, regardless of clients or agents.
    await Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (queue.length && !this.stopped) {
          const [url, title] = queue.shift()!;
          this.attempts.push(Date.now());
          let value: AgentPullRequest;
          try {
            value = await this.read(url, title);
          } catch {
            value = { url, title, status: "Unavailable" };
          }
          const previous = this.urls.get(url);
          const failures =
            value.status === "Unavailable" ? (previous?.failures ?? 0) + 1 : 0;
          const delay = failures
            ? Math.min(4 * 60 * 60_000, 15 * 60_000 * 2 ** (failures - 1))
            : value.status === "Merged"
              ? Infinity
              : value.status === "Closed"
                ? 6 * 60 * 60_000
                : 5 * 60_000;
          this.urls.set(url, {
            value,
            failures,
            checkedAt: Date.now(),
            due: Date.now() + delay,
          });
          this.pendingUrls.delete(url);
        }
      })
    );
    if (this.stopped) return;
    for (const url of this.urls.keys())
      if (!links.has(url)) this.urls.delete(url);
    publishSnapshots();
  }
}
