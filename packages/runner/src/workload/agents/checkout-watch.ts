import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

type Close = () => void;
type Open = (root: string, changed: () => void, closed: () => void) => Close;

/** One OS watch per checkout, even if a reviewer and author both have it open. */
export class SharedCheckoutWatches {
  private readonly roots = new Map<
    string,
    { listeners: Map<() => void, () => void>; close: Close }
  >();
  constructor(private readonly open: Open) {}
  subscribe(root: string, changed: () => void, closed: () => void): Close {
    let group = this.roots.get(root);
    if (!group) {
      const listeners = new Map([[changed, closed]]);
      group = { listeners, close: () => {} };
      this.roots.set(root, group);
      group.close = this.open(
        root,
        () => {
          for (const notify of listeners.keys()) notify();
        },
        () => {
          if (this.roots.get(root) !== group) return;
          this.roots.delete(root);
          for (const end of listeners.values()) end();
        }
      );
    } else group.listeners.set(changed, closed);
    return () => {
      group.listeners.delete(changed);
      if (!group.listeners.size && this.roots.get(root) === group) {
        this.roots.delete(root);
        group.close();
      }
    };
  }
}

/** Run in the native process or the Linux workload account. Never recursively
 * watch an arbitrary non-repository cwd (it may be a user's home directory). */
export const watchCheckout: Open = (root, changed, closed) => {
  let stopped = false;
  let watcher: ReturnType<typeof watch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    stopped = true;
    watcher?.close();
    clearTimeout(timer);
  };
  void stat(path.join(root, ".git"))
    .then(
      () => true,
      () => false
    )
    .then((recursive) => {
      if (stopped) return;
      try {
        watcher = watch(root, { recursive, persistent: false }, (_, name) => {
          if (
            name &&
            (/(^|\/)(node_modules|\.dispatch)(\/|$)/.test(name) ||
              /(^|\/)\.git\/(objects\/|logs\/|.*\.lock$)/.test(name))
          )
            return;
          if (!timer)
            timer = setTimeout(() => {
              timer = undefined;
              changed();
            }, 450);
        });
        changed(); // Reconcile edits during asynchronous watch setup.
        watcher.once("error", () => {
          close();
          closed();
        });
      } catch {
        close();
        closed();
      }
    });
  return close;
};

export function childWatch(
  child: ChildProcessWithoutNullStreams,
  changed: () => void,
  closed: () => void
): Close {
  child.stdout.on("data", changed);
  child.stderr.resume();
  child.stdin.on("error", () => {});
  let closing = false;
  child.on("error", () => {});
  child.once("close", () => {
    if (!closing) closed();
  });
  return () => {
    closing = true;
    child.stdin.end();
    child.kill();
  };
}

export function runCheckoutWatchCli(cwd: string) {
  const close = watchCheckout(
    cwd,
    () => process.stdout.write("1\n"),
    () => process.exit(1)
  );
  // The root supervisor closing its pipe (including on a crash) releases the watcher.
  process.stdin
    .on("end", () => {
      close();
      process.exit(0);
    })
    .resume();
}
