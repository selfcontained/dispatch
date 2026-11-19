import {
  isGitHubPullRequestTarget,
  MAX_PULL_REQUEST_WATCH_TARGETS,
  type GitHubPullRequestWatchEvent,
} from "@dispatch/runner-protocol";
import { githubPullRequestTarget } from "./pull-request-reader.js";
import type { RemoteRunnerService } from "./remote/service.js";

type Sample = Extract<GitHubPullRequestWatchEvent, { type: "observation" }>;
type Watch = {
  urls: Set<string>;
  samples: Map<string, { sample: Sample; until: number }>;
  until: number;
  close?: () => void;
};

const freshness = 7 * 60_000;

/** Track one union of the host's interests per authenticated runner. */
export class PullRequestObservations {
  private readonly watches = new Map<string, Watch>();
  private readonly retries = new Map<string, number>();

  constructor(
    private readonly remote: Pick<
      RemoteRunnerService,
      "canWatchPullRequests" | "watchPullRequests"
    >,
    private readonly changed: () => void,
    private readonly reset: (runnerId: string) => void
  ) {}

  update(groups: Map<string, string[]>) {
    for (const id of this.retries.keys())
      if (!groups.has(id)) this.retries.delete(id);
    for (const id of this.watches.keys()) if (!groups.has(id)) this.remove(id);
    for (const [id, urls] of groups) {
      const targets = new Set(
        urls
          .filter((url) =>
            isGitHubPullRequestTarget(githubPullRequestTarget(url))
          )
          .sort()
          .slice(0, MAX_PULL_REQUEST_WATCH_TARGETS)
      );
      if (!targets.size || !this.remote.canWatchPullRequests(id)) {
        this.remove(id);
        continue;
      }
      const previous = this.watches.get(id);
      if (
        previous &&
        targets.size === previous.urls.size &&
        [...targets].every((url) => previous.urls.has(url))
      )
        continue;
      if ((this.retries.get(id) ?? 0) > Date.now()) continue;
      this.retries.delete(id);
      const watch: Watch = {
        urls: targets,
        samples: new Map(),
        until: Date.now() + freshness,
      };
      this.watches.set(id, watch);
      const ended = () => {
        if (this.watches.get(id) !== watch) return;
        this.remove(id);
        this.retries.set(id, Date.now() + 30_000);
        this.changed();
      };
      void this.remote
        .watchPullRequests(
          id,
          [...targets],
          (event) => {
            if (this.watches.get(id) !== watch) return;
            if (event.type === "reset") {
              watch.samples.clear();
              watch.until = Date.now() + freshness;
              this.reset(id);
            } else {
              const url =
                "https://github.com/" +
                `${event.target.owner.toLowerCase()}/${event.target.repo.toLowerCase()}/pull/${event.target.number}`;
              if (!targets.has(url)) return;
              if (
                (watch.samples.get(url)?.sample.observedAt ?? -1) >
                event.observedAt
              )
                return;
              watch.samples.set(url, {
                sample: event,
                until: Date.now() + freshness,
              });
              this.changed();
            }
          },
          ended
        )
        .then((close) => {
          if (this.watches.get(id) !== watch) close();
          else watch.close = close;
        })
        .catch(ended)
        .finally(() => previous?.close?.());
    }
  }

  get(id: string | null, url: string) {
    const watch = id === null ? undefined : this.watches.get(id);
    if (!watch?.urls.has(url)) return undefined;
    return watch.samples.get(url) ?? { sample: undefined, until: watch.until };
  }

  get retryAt() {
    return Math.min(Infinity, ...this.retries.values());
  }

  remove(id: string) {
    const watch = this.watches.get(id);
    this.watches.delete(id);
    this.retries.delete(id);
    watch?.close?.();
  }

  close() {
    for (const id of this.watches.keys()) this.remove(id);
    this.retries.clear();
  }
}
