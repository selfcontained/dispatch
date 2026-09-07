import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

/**
 * dsh's local credential store (`<DSH_HOME>/.credentials.yaml`, written by
 * dsh-credentials-local): `refs` hold key values by env name, `records`
 * hold per-plugin credentials by `<owner>/<id>`. The one record Dispatch
 * reads is the ChatGPT sign-in pi-ai stores for its `openai-codex` route,
 * which lets the harness run on a ChatGPT plan instead of an API key.
 */

/** The record key llm-pi-ai writes for a ChatGPT (Codex) sign-in. */
export const CODEX_GRANT_KEY = "llm-pi-ai/openai-codex";

/** pi-ai's OAuth credential, stored verbatim as the grant payload. */
export type CodexGrant = {
  access: string;
  refresh?: string;
  /** Unix ms when the access token expires. */
  expires?: number;
  accountId?: string;
};

export function credentialsPath(dshHome: string): string {
  return path.join(dshHome, ".credentials.yaml");
}

type Store = { records?: Record<string, { kind?: string; payload?: unknown }> };

/** The store's records by key; empty when there is no readable store. */
export async function readCredentialRecords(
  dshHome: string
): Promise<Map<string, { kind: string; payload: unknown }>> {
  const records = new Map<string, { kind: string; payload: unknown }>();
  let text: string;
  try {
    text = await readFile(credentialsPath(dshHome), "utf8");
  } catch {
    return records;
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return records;
  }
  const stored = (doc as Store | null)?.records;
  if (typeof stored !== "object" || stored === null) return records;
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value !== "object" || value === null) continue;
    records.set(key, {
      kind: typeof value.kind === "string" ? value.kind : "",
      payload: value.payload,
    });
  }
  return records;
}

/** The keys of every stored record: which provider routes are signed in. */
export async function readGrantKeys(dshHome: string): Promise<Set<string>> {
  return new Set((await readCredentialRecords(dshHome)).keys());
}

/** The ChatGPT sign-in, when one is stored and shaped like pi-ai writes it. */
export async function readCodexGrant(
  dshHome: string
): Promise<CodexGrant | null> {
  const record = (await readCredentialRecords(dshHome)).get(CODEX_GRANT_KEY);
  if (!record || record.kind !== "grant") return null;
  const payload = record.payload as Partial<CodexGrant> | null;
  if (typeof payload?.access !== "string" || !payload.access) return null;
  return {
    access: payload.access,
    ...(typeof payload.refresh === "string"
      ? { refresh: payload.refresh }
      : {}),
    ...(typeof payload.expires === "number"
      ? { expires: payload.expires }
      : {}),
    ...(typeof payload.accountId === "string"
      ? { accountId: payload.accountId }
      : {}),
  };
}

export type GrantSnapshot = {
  /** The last-read record keys; a stale read is refreshed in the background. */
  peek(): ReadonlySet<string>;
  /** Re-read the store when the snapshot is older than the TTL; one read at a time. */
  refresh(): Promise<ReadonlySet<string>>;
};

/**
 * The store's record keys as a snapshot for synchronous readers. Config
 * reads are synchronous and polled every few seconds, so they answer from
 * the last read and kick off the next; a fresh sign-in shows on the
 * following poll. A read that fails keeps the last snapshot.
 */
export function createGrantSnapshot(
  dshHome: string,
  ttlMs: number
): GrantSnapshot {
  let at = 0;
  let keys: ReadonlySet<string> = new Set();
  let inFlight: Promise<ReadonlySet<string>> | null = null;
  const refresh = (): Promise<ReadonlySet<string>> => {
    if (inFlight) return inFlight;
    if (Date.now() - at < ttlMs) return Promise.resolve(keys);
    inFlight = readGrantKeys(dshHome)
      .then((next) => {
        at = Date.now();
        keys = next;
        return keys;
      })
      .catch(() => keys)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    peek() {
      if (Date.now() - at >= ttlMs) void refresh();
      return keys;
    },
    refresh,
  };
}
