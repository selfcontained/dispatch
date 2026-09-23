/**
 * How often an agent's stream writes reach the listeners that republish its
 * turn. Every listener call sends the whole running turn to every browser
 * tab, and a turn grows with each step, so a busy agent at the old 100 ms
 * cadence put megabytes a second on the wire and into each tab's parser.
 *
 * A write is told after a short batching pause, then at most once per
 * interval per agent. An immediate write (a turn starting or settling, the
 * process exiting) is told at once and drops the one waiting, so the final
 * snapshot is never followed by an older one from a timer.
 */
export const STREAM_WRITE_BATCH_MS = 100;
export const STREAM_WRITE_INTERVAL_MS = 1_000;

export class StreamWriteThrottle {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastFired = new Map<string, number>();

  constructor(
    private readonly fire: (agentId: string) => void,
    private readonly intervalMs = STREAM_WRITE_INTERVAL_MS,
    private readonly batchMs = STREAM_WRITE_BATCH_MS
  ) {}

  write(agentId: string, immediate: boolean): void {
    const pending = this.timers.get(agentId);
    if (immediate) {
      if (pending) clearTimeout(pending);
      this.run(agentId);
      return;
    }
    if (pending) return;
    const since = Date.now() - (this.lastFired.get(agentId) ?? -Infinity);
    const wait = Math.max(this.batchMs, this.intervalMs - since);
    const timer = setTimeout(() => this.run(agentId), wait);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  /** Agents told within the last interval: the only ones still paced. */
  pacedCount(): number {
    return this.lastFired.size;
  }

  private run(agentId: string): void {
    const now = Date.now();
    this.timers.delete(agentId);
    // A time older than the interval paces nothing, so it goes: the map
    // holds only agents that wrote in the last second, not every agent
    // that ever ran.
    for (const [id, at] of this.lastFired) {
      if (now - at >= this.intervalMs) this.lastFired.delete(id);
    }
    this.lastFired.set(agentId, now);
    // State is settled before the listener runs, so one that throws leaves
    // the next write paced as usual.
    this.fire(agentId);
  }
}
