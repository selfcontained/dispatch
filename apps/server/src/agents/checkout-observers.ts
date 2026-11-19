import { remotePlacement } from "@dispatch/runner-protocol";
import {
  agentWorkspaceDir,
  type WorkspaceTargetAgent,
} from "./workspace-target.js";
import { SharedCheckoutWatches, watchCheckout } from "./checkout-watch.js";
import type { RemoteRunnerService } from "./remote/service.js";

type Interest = {
  runner?: string;
  watching: boolean;
  key: string;
  expires: number;
  close: () => void;
};

/** HTTP reads renew interest. A disconnected subscription reopens on the next
 * read, and an active view periodically rereads even if the OS drops an event. */
export class CheckoutObservers {
  private readonly local = new SharedCheckoutWatches(watchCheckout);
  private readonly agents = new Map<string, Interest>();
  private readonly unsubscribe?: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly remote:
      | Pick<RemoteRunnerService, "requestSession" | "onConnectionChange">
      | undefined,
    private readonly changed: (id: string) => void
  ) {
    this.unsubscribe = remote?.onConnectionChange((runnerId) => {
      for (const [id, item] of this.agents) {
        if (item.runner !== runnerId) continue;
        item.watching = false;
        item.close();
        if (item.expires >= Date.now()) this.changed(id);
      }
    });
    this.timer = setInterval(() => {
      for (const [id, item] of this.agents)
        if (item.expires < Date.now()) {
          this.agents.delete(id);
          item.close();
        }
    }, 15_000);
    this.timer.unref();
  }
  observe(agent: WorkspaceTargetAgent & { id: string }) {
    const id = agent.id;
    const placement = agent.cwd && remotePlacement(agent.cwd);
    const key = placement
      ? JSON.stringify([agent.cwd, agent.workspacePath])
      : agentWorkspaceDir(agent);
    if (!key) return;
    const expires = Date.now() + 75_000;
    const prev = this.agents.get(id);
    if (prev?.key === key) {
      prev.expires = expires;
      if (prev.watching) return;
    }
    prev?.close();
    const item: Interest = {
      key,
      runner: placement ? placement.runner : undefined,
      watching: true,
      expires,
      close: () => {},
    };
    this.agents.set(id, item);
    const active = () => this.agents.get(id) === item;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      if (!active() || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (active()) this.changed(id);
      }, 100);
    };
    const ended = () => {
      if (active()) item.watching = false;
      clearTimeout(timer);
    };
    if (!placement) {
      item.close = this.local.subscribe(key, notify, ended);
      return;
    }
    if (!this.remote) {
      this.agents.delete(id);
      return;
    }
    void this.remote
      .requestSession(placement, { kind: "watchCheckout", agentId: id })
      .then(({ channel }) => {
        if (!channel || !active()) {
          ended();
          channel?.destroy();
          return;
        }
        item.close = () => channel.destroy();
        channel.on("data", notify);
        channel.once("end", () => {
          ended();
          channel.destroy();
        });
        channel.once("close", () => {
          if (active()) item.watching = false;
        });
      })
      .catch(() => {
        ended();
      });
  }
  close() {
    this.unsubscribe?.();
    clearInterval(this.timer);
    for (const item of this.agents.values()) item.close();
    this.agents.clear();
  }
}
