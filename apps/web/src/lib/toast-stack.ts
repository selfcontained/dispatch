/**
 * How much a toast matters when there's no room. Success and info pass;
 * attention is also kept in Notifications; a warning, an error or a toast
 * that waits for an answer holds its place.
 */
export const TOAST_PRIORITY = { passing: 0, attention: 1, holds: 2 } as const;

export type StackedToast = {
  key: string;
  priority: (typeof TOAST_PRIORITY)[keyof typeof TOAST_PRIORITY];
};

/**
 * Keeps at most `limit` toasts up. A new one takes the place of the oldest
 * that matters no more than it does and doesn't hold; otherwise it waits.
 * So an error is never pushed out of sight by what arrives after it.
 */
export class ToastStack<T extends StackedToast> {
  private showing: T[] = [];
  private waiting: T[] = [];

  constructor(
    private readonly display: (toast: T) => void,
    private readonly evict: (toast: T) => void,
    private readonly limit = 3
  ) {}

  push(toast: T): void {
    const shown = this.showing.findIndex(({ key }) => key === toast.key);
    if (shown !== -1) {
      this.showing[shown] = toast;
      this.display(toast);
      return;
    }
    const queued = this.waiting.findIndex(({ key }) => key === toast.key);
    if (queued !== -1) {
      this.waiting[queued] = toast;
      return;
    }
    if (this.showing.length >= this.limit) {
      const [victim] = this.showing
        .filter(
          ({ priority }) =>
            priority < TOAST_PRIORITY.holds && priority <= toast.priority
        )
        .sort((a, b) => a.priority - b.priority);
      if (!victim) {
        this.wait(toast);
        return;
      }
      this.showing = this.showing.filter((item) => item !== victim);
      this.evict(victim);
    }
    this.showing.push(toast);
    this.display(toast);
  }

  remove(key: string): void {
    this.waiting = this.waiting.filter((toast) => toast.key !== key);
    const before = this.showing.length;
    this.showing = this.showing.filter((toast) => toast.key !== key);
    if (this.showing.length === before || !this.waiting.length) return;
    const next = this.waiting.reduce((best, toast) =>
      toast.priority > best.priority ? toast : best
    );
    this.waiting = this.waiting.filter((toast) => toast !== next);
    this.showing.push(next);
    this.display(next);
  }

  clear(): T[] {
    const all = [...this.showing, ...this.waiting];
    this.showing = [];
    this.waiting = [];
    return all;
  }

  private wait(toast: T): void {
    this.waiting.push(toast);
    // Only what holds is worth showing late in a burst.
    const stale = this.waiting.filter(
      ({ priority }) => priority < TOAST_PRIORITY.holds
    );
    if (stale.length > this.limit) {
      this.waiting = this.waiting.filter((item) => item !== stale[0]);
      this.evict(stale[0]);
    }
  }
}
