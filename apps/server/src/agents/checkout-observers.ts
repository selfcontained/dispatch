import type { CallerChannel } from "@dispatch/runner-protocol/contract";
import {
  sessionRunner,
  target,
  type CheckoutReadRunners,
} from "./checkout-runner.js";
import type { AgentRecord } from "./types.js";

type ObservedAgent = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "workspacePath" | "baseBranch"
> &
  Partial<Pick<AgentRecord, "placement">>;

type Interest = {
  watching: boolean;
  key: string;
  expires: number;
  close: () => void;
};

/** HTTP reads renew interest. A disconnected subscription reopens on the next
 * read, and an active view periodically rereads even if the OS drops an event.
 * Every placement watches through the session's runner (`checkout.watch`),
 * which keeps one OS watch per checkout. */
export class CheckoutObservers {
  private readonly agents = new Map<string, Interest>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly runners: () => CheckoutReadRunners,
    private readonly changed: (id: string) => void
  ) {
    this.timer = setInterval(() => {
      for (const [id, item] of this.agents)
        if (item.expires < Date.now()) {
          this.agents.delete(id);
          item.close();
        }
    }, 15_000);
    this.timer.unref();
  }
  observe(agent: ObservedAgent) {
    const id = agent.id;
    const key = JSON.stringify([
      agent.placement ?? null,
      agent.cwd,
      agent.worktreePath ?? null,
      agent.workspacePath ?? null,
    ]);
    const expires = Date.now() + 75_000;
    const prev = this.agents.get(id);
    if (prev?.key === key) {
      prev.expires = expires;
      if (prev.watching) return;
    }
    prev?.close();
    const item: Interest = {
      key,
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
    let channel: CallerChannel<"checkout.watch"> | undefined;
    let closed = false;
    let runner;
    try {
      runner = sessionRunner(this.runners(), agent);
    } catch {
      this.agents.delete(id);
      return;
    }
    // A runner that reconnects may have lost its watch: reread, then reopen
    // on the next read.
    const offConnection = runner.connection.onChange(() => {
      if (!active()) return;
      item.watching = false;
      item.close();
      if (item.expires >= Date.now()) this.changed(id);
    });
    item.close = () => {
      closed = true;
      offConnection();
      clearTimeout(timer);
      channel?.close();
    };
    void runner
      .open("checkout.watch", { target: target(agent) })
      .then((opened) => {
        channel = opened.channel;
        if (closed || !active()) {
          ended();
          channel.close();
          return;
        }
        channel.onData(notify);
        channel.onClose(ended);
      })
      .catch(ended);
  }
  close() {
    clearInterval(this.timer);
    for (const item of this.agents.values()) item.close();
    this.agents.clear();
  }
}
