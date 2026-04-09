import { randomUUID } from "node:crypto";

type TerminalTokenRecord = {
  agentId: string;
  expiresAtMs: number;
};

export class TerminalTokenStore {
  private readonly ttlMs: number;
  private readonly records = new Map<string, TerminalTokenRecord>();

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  issue(agentId: string): string {
    this.cleanupExpired();
    const token = randomUUID().replaceAll("-", "");
    this.records.set(token, {
      agentId,
      expiresAtMs: Date.now() + this.ttlMs
    });
    return token;
  }

  consume(agentId: string, token: string): boolean {
    this.cleanupExpired();
    const record = this.records.get(token);
    if (!record) {
      return false;
    }

    this.records.delete(token);
    return record.agentId === agentId && record.expiresAtMs >= Date.now();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, record] of this.records.entries()) {
      if (record.expiresAtMs < now) {
        this.records.delete(token);
      }
    }
  }
}
