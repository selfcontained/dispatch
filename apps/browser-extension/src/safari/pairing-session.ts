import type { PairingSessionState } from "../types";

export const PENDING_PAIRING_KEY = "dispatchPendingPairing";
const POLL_INTERVAL_MS = 2_500;

export interface PendingPairing {
  baseUrl: string;
  pairingId: string;
  pairingSecret: string;
  code: string;
  expiresAt: string;
}

type StoredPairingRecord =
  | { kind: "pending"; pending: PendingPairing }
  | { kind: "approved"; baseUrl: string };

export interface PairingSessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PairingSessionDeps {
  storage: PairingSessionStorage;
  exchange(
    pending: PendingPairing
  ): Promise<{ status: "pending" | "approved" }>;
  disconnect(): Promise<void>;
}

type ExchangeOutcome = "pending" | "approved" | "error";

/**
 * Owns the pairing poll loop. On Safari the popup is destroyed the moment the
 * verification tab opens, so unlike the Chrome side panel the poll must live
 * in the background — and because the background worker itself can be killed,
 * the pending pairing is persisted and `status()` performs an immediate
 * exchange so a reopened popup resumes (or completes) pairing in one call.
 */
export class PairingSession {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<ExchangeOutcome> | null = null;
  private epoch = 0;

  constructor(private readonly deps: PairingSessionDeps) {}

  async begin(pending: PendingPairing): Promise<void> {
    this.epoch += 1;
    this.stopTimer();
    await this.deps.storage.set({
      [PENDING_PAIRING_KEY]: {
        kind: "pending",
        pending,
      } satisfies StoredPairingRecord,
    });
    this.schedule(pending, this.epoch);
  }

  async status(): Promise<PairingSessionState> {
    const record = await this.readRecord();
    if (!record) return { state: "idle" };
    if (record.kind === "approved") {
      await this.deps.storage.remove(PENDING_PAIRING_KEY);
      return { state: "approved", baseUrl: record.baseUrl };
    }
    const pending = record.pending;
    if (this.isExpired(pending)) {
      this.epoch += 1;
      this.stopTimer();
      await this.deps.storage.remove(PENDING_PAIRING_KEY);
      return { state: "expired" };
    }
    const epoch = this.epoch;
    const outcome = await this.attemptExchange(pending, epoch);
    if (outcome === "approved") {
      await this.deps.storage.remove(PENDING_PAIRING_KEY);
      return { state: "approved", baseUrl: pending.baseUrl };
    }
    if (epoch === this.epoch) this.schedule(pending, epoch);
    return {
      state: "pending",
      baseUrl: pending.baseUrl,
      code: pending.code,
      expiresAt: pending.expiresAt,
    };
  }

  async cancel(): Promise<void> {
    this.epoch += 1;
    this.stopTimer();
    const inFlight = this.inFlight;
    await this.deps.storage.remove(PENDING_PAIRING_KEY);
    if (inFlight && (await inFlight) === "approved") {
      // The late approval already stored a connection; revoke it, matching
      // the Chrome side panel's cancel semantics.
      await this.deps.disconnect().catch(() => undefined);
    }
  }

  private async readRecord(): Promise<StoredPairingRecord | null> {
    const stored = await this.deps.storage.get(PENDING_PAIRING_KEY);
    return (
      (stored[PENDING_PAIRING_KEY] as StoredPairingRecord | undefined) ?? null
    );
  }

  private isExpired(pending: PendingPairing): boolean {
    const expiresAt = Date.parse(pending.expiresAt);
    return Number.isNaN(expiresAt) || expiresAt <= Date.now();
  }

  private schedule(pending: PendingPairing, epoch: number): void {
    this.stopTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll(pending, epoch);
    }, POLL_INTERVAL_MS);
  }

  private async poll(pending: PendingPairing, epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    if (this.isExpired(pending)) {
      await this.deps.storage.remove(PENDING_PAIRING_KEY);
      return;
    }
    const outcome = await this.attemptExchange(pending, epoch);
    if (epoch !== this.epoch) return;
    if (outcome !== "approved") this.schedule(pending, epoch);
  }

  private async attemptExchange(
    pending: PendingPairing,
    epoch: number
  ): Promise<ExchangeOutcome> {
    const attempt: Promise<ExchangeOutcome> = this.deps
      .exchange(pending)
      .then((result) => result.status)
      .catch(() => "error" as const);
    this.inFlight = attempt;
    const outcome = await attempt;
    if (this.inFlight === attempt) this.inFlight = null;
    if (outcome === "approved" && epoch === this.epoch) {
      this.stopTimer();
      await this.deps.storage.set({
        [PENDING_PAIRING_KEY]: {
          kind: "approved",
          baseUrl: pending.baseUrl,
        } satisfies StoredPairingRecord,
      });
    }
    return outcome;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
