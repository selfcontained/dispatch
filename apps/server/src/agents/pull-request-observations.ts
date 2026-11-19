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
  samples: Map<string, Sample>;
  renewAt: number;
  close?: () => void;
  ended?: true;
};

// Receipt deadlines only govern channel recovery. Samples carry their
// own provider timestamp, which a replay leaves unchanged.
const deliveryTimeout = 7 * 60_000;
const retryDelay = 30_000;

/** Track one union of the host's interests per authenticated runner. */
export class PullRequestObservations {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly remote: Pick<
      RemoteRunnerService,
      "canWatchPullRequests" | "watchPullRequests"
    >,
    private readonly changed: () => void,
    private readonly reset: (runnerId: string) => void
  ) {}

  update(groups: Map<string, string[]>) {
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
        previous.renewAt > Date.now() &&
        targets.size === previous.urls.size &&
        [...targets].every((url) => previous.urls.has(url))
      )
        continue;
      const watch: Watch = {
        urls: targets,
        samples: new Map(),
        renewAt: Date.now() + deliveryTimeout,
      };
      this.watches.set(id, watch);
      const ended = () => {
        if (this.watches.get(id) !== watch) return;
        watch.ended = true;
        watch.renewAt = Date.now() + retryDelay;
        this.changed();
      };
      void this.remote
        .watchPullRequests(
          id,
          [...targets],
          (event) => {
            if (this.watches.get(id) !== watch || watch.ended) return;
            watch.renewAt = Date.now() + deliveryTimeout;
            if (event.type === "reset") {
              watch.samples.clear();
              this.reset(id);
            } else {
              const url =
                "https://github.com/" +
                `${event.target.owner.toLowerCase()}/${event.target.repo.toLowerCase()}/pull/${event.target.number}`;
              if (!targets.has(url)) return;
              if (
                (watch.samples.get(url)?.observedAt ?? -1) >= event.observedAt
              )
                return;
              watch.samples.set(url, event);
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
    return { sample: watch.samples.get(url) };
  }

  get nextAt() {
    return Math.min(
      Infinity,
      ...[...this.watches.values()].map((watch) => watch.renewAt)
    );
  }

  remove(id: string) {
    const watch = this.watches.get(id);
    this.watches.delete(id);
    watch?.close?.();
  }

  close() {
    for (const id of this.watches.keys()) this.remove(id);
  }
}
