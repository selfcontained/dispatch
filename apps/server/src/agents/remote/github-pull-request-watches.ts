import {
  githubPullRequestTargetKey,
  MAX_PULL_REQUEST_WATCH_TARGETS,
  type GitHubPullRequestObservation,
  type GitHubPullRequestTarget,
  type GitHubPullRequestWatchEvent,
} from "./protocol.js";

type Sample = Extract<GitHubPullRequestWatchEvent, { type: "observation" }>;
type Receiver = (event: GitHubPullRequestWatchEvent) => void;
type Entry = {
  target: GitHubPullRequestTarget;
  receivers: Set<Receiver>;
  due: number;
  sample?: Sample;
  flight?: Promise<Sample>;
};

/** One bounded queue per workload account, including across transport reconnects. */
export class GitHubPullRequestWatches {
  private entries = new Map<string, Entry>();
  private attempts: number[] = [];
  private active = 0;
  private subscriptions = 0;
  private paused = 0;
  private revision = 0;
  private credential?: string;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly read: (
      target: GitHubPullRequestTarget,
      signal: AbortSignal
    ) => Promise<GitHubPullRequestObservation>,
    private readonly interval = 30_000
  ) {}

  subscribe(targets: GitHubPullRequestTarget[], receiver: Receiver) {
    const entries = new Map(
      targets.map(({ owner, repo, number }) => {
        const target = { owner, repo, number };
        return [githubPullRequestTargetKey(target), target];
      })
    );
    const additions = [...entries.keys()].filter(
      (key) => !this.entries.has(key)
    );
    if (
      this.subscriptions >= 16 ||
      this.entries.size + additions.length > 2 * MAX_PULL_REQUEST_WATCH_TARGETS
    )
      throw new Error("Runner pull request watch capacity reached.");
    this.subscriptions++;
    for (const [key, target] of entries) {
      const entry = this.entry(key, target);
      entry.receivers.add(receiver);
      if (entry.sample) receiver(entry.sample);
    }
    this.schedule();
    return () => {
      this.subscriptions--;
      for (const key of entries.keys()) {
        const entry = this.entries.get(key)!;
        entry.receivers.delete(receiver);
        if (!entry.receivers.size && !entry.flight) this.entries.delete(key);
      }
      this.schedule();
    };
  }

  reset() {
    this.revision++;
    this.credential = undefined;
    const receivers = new Set<Receiver>();
    for (const entry of this.entries.values()) {
      entry.sample = undefined;
      entry.due = 0;
      for (const receiver of entry.receivers) receivers.add(receiver);
    }
    for (const receiver of receivers) receiver({ type: "reset" });
    this.schedule();
  }

  async accountOperation<T>(run: () => Promise<T>) {
    this.paused++;
    this.reset();
    try {
      return await run();
    } finally {
      this.paused--;
      this.schedule();
    }
  }

  refreshIfWatched(target: GitHubPullRequestTarget) {
    const key = githubPullRequestTargetKey(target);
    const entry = this.entries.get(key);
    if (!entry?.receivers.size) return undefined;
    return this.refresh(key, entry);
  }

  private async refresh(key: string, entry: Entry) {
    if (entry.flight) return (await entry.flight).observation;
    if (this.paused || this.active >= 2 || this.budgetDue() > Date.now())
      throw new Error("Runner pull request refresh budget reached.");
    return (await this.sample(key, entry)).observation;
  }

  private entry(key: string, target: GitHubPullRequestTarget) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { target, due: 0, receivers: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private budgetDue() {
    this.attempts = this.attempts.filter((at) => at > Date.now() - 60_000);
    return this.attempts.length >= 12 ? this.attempts[0] + 60_000 : 0;
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.paused || this.active >= 2) return;
    const next = [...this.entries]
      .filter(([, entry]) => entry.receivers.size && !entry.flight)
      .sort(([, a], [, b]) => a.due - b.due)[0];
    if (!next) return;
    this.timer = setTimeout(
      () => {
        void this.sample(...next).catch(() => {});
        this.schedule();
      },
      Math.max(0, next[1].due - Date.now(), this.budgetDue() - Date.now())
    );
    this.timer.unref();
  }

  private sample(key: string, entry: Entry) {
    this.active++;
    this.attempts.push(Date.now());
    const revision = this.revision;
    entry.flight = this.read(entry.target, AbortSignal.timeout(17_000))
      .catch(() => null)
      .then((observation): Sample => {
        if (revision !== this.revision)
          throw new Error("Runner GitHub account changed.");
        const credential = observation?.credentialContext;
        if (credential && this.credential && this.credential !== credential)
          this.reset();
        if (credential) this.credential = credential;
        const sample: Sample = {
          type: "observation",
          target: entry.target,
          observedAt: Date.now(),
          observation,
        };
        entry.sample = sample;
        entry.due = sample.observedAt + this.interval;
        for (const receiver of entry.receivers) receiver(sample);
        return sample;
      })
      .finally(() => {
        this.active--;
        entry.flight = undefined;
        if (!entry.receivers.size) this.entries.delete(key);
        this.schedule();
      });
    return entry.flight;
  }
}
