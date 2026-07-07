import type {
  ProviderQuotaProviderAdapter,
  ProviderQuotaRefreshOptions,
} from "./types.js";
import { ProviderQuotaStore } from "./store.js";

type SchedulerOptions = {
  intervalMs: number;
  initialDelayMs: number;
  onError?: (error: unknown) => void;
};

export class ProviderQuotaService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private inFlightRefresh: Promise<unknown> | null = null;

  constructor(
    private readonly store: ProviderQuotaStore,
    private readonly adapters: ProviderQuotaProviderAdapter[],
    private readonly isEnabled: () => Promise<boolean> = async () => true
  ) {}

  listLatest() {
    return this.store.listLatest();
  }

  async refreshAll(options: ProviderQuotaRefreshOptions = {}) {
    if (!(await this.isEnabled())) {
      return [];
    }
    if (this.inFlightRefresh) {
      return await this.inFlightRefresh;
    }
    this.inFlightRefresh = this.refreshAllNow(options).finally(() => {
      this.inFlightRefresh = null;
    });
    return await this.inFlightRefresh;
  }

  private async refreshAllNow(options: ProviderQuotaRefreshOptions) {
    const results = await Promise.all(
      this.adapters.map(async (adapter) => {
        const result = await adapter.refresh(options);
        if (result.persist !== false && result.snapshots.length > 0) {
          await this.store.upsertSnapshots(result.snapshots);
        }
        return result;
      })
    );
    return results;
  }

  startScheduler(options: SchedulerOptions): void {
    if (this.interval || this.initialTimeout) return;
    const refresh = () => {
      void this.refreshAll({ interaction: "background" }).catch((error) => {
        options.onError?.(error);
      });
    };
    this.initialTimeout = setTimeout(refresh, options.initialDelayMs);
    this.interval = setInterval(refresh, options.intervalMs);
  }

  stopScheduler(): void {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
