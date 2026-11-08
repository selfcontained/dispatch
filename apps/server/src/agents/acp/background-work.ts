import type { BackgroundItem, BackgroundSnapshot } from "@dispatch/shared";
import type { BackgroundUpdate } from "./background-ingress.js";

/** Small connection-local registry. No database, journal, output or history. */
export class BackgroundWorkRegistry {
  private status: BackgroundSnapshot["status"] = "unsupported";
  private readonly items = new Map<
    string,
    {
      name?: string;
      kind?: BackgroundItem["kind"];
      state: BackgroundItem["state"];
    }
  >();
  // IDs only: late metadata must not recreate an already-finished command.
  private readonly finished = new Set<string>();
  setSupported(supported: boolean): void {
    if (this.status !== "unavailable")
      this.status = supported ? "supported" : "unsupported";
  }
  invalidate(): void {
    this.status = "unavailable";
    this.items.clear();
  }
  apply(update: BackgroundUpdate): void {
    if (this.status !== "supported") return;
    const id = update.asyncTaskId;
    if (
      update.sessionUpdate === "async_task_state_update" &&
      !["running", "paused"].includes(update.state)
    ) {
      this.items.delete(id);
      if (this.finished.size >= 1000 && !this.finished.has(id))
        this.invalidate();
      else this.finished.add(id);
      return;
    }
    if (this.finished.has(id)) return;
    const old = this.items.get(id);
    if (update.sessionUpdate === "async_task_spawned") {
      if (update.taskType !== "shell" && update.taskType !== "monitor") return;
      this.items.set(id, {
        name: update.name,
        kind: update.taskType,
        state: old?.state ?? "running",
      });
    } else if (
      update.sessionUpdate === "async_task_state_update" &&
      (update.state === "running" || update.state === "paused")
    ) {
      this.items.set(id, { ...old, state: update.state });
    }
    if (this.items.size > 200) this.invalidate();
  }
  snapshot(): BackgroundSnapshot {
    return {
      status: this.status,
      items: [...this.items].flatMap(([id, item]) =>
        item.name && item.kind
          ? [{ id, name: item.name, kind: item.kind, state: item.state }]
          : []
      ),
    };
  }
}
