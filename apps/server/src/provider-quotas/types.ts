export type ProviderQuotaProvider = "codex" | "claude";
export type ProviderQuotaStatus = "ok" | "unavailable" | "error";

export type ProviderQuotaSnapshot = {
  provider: ProviderQuotaProvider;
  accountLabel: string | null;
  accountId: string | null;
  source: string;
  windowId: string;
  title: string;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: Date | null;
  fetchedAt: Date;
  status: ProviderQuotaStatus;
  error: string | null;
};

export type ProviderQuotaRefreshResult = {
  provider: ProviderQuotaProvider;
  snapshots: ProviderQuotaSnapshot[];
  status: ProviderQuotaStatus;
  error: string | null;
  persist?: boolean;
};

export type ProviderQuotaRefreshInteraction = "background" | "manual";

export type ProviderQuotaRefreshOptions = {
  interaction?: ProviderQuotaRefreshInteraction;
};

export type ProviderQuotaProviderAdapter = {
  provider: ProviderQuotaProvider;
  refresh(
    options?: ProviderQuotaRefreshOptions
  ): Promise<ProviderQuotaRefreshResult>;
};
