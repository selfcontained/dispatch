/**
 * What every provider billing client in this module shares: the fetch
 * shape tests can fake, the per-provider deadline, a JSON reader that
 * does not echo a proxy page, and the error type whose message is fit
 * to show a user as is.
 */

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** One deadline per provider for its whole pagination, not per page. */
export const PROVIDER_DEADLINE_MS = 15_000;

/**
 * A billing failure whose message is written for the user: which provider
 * answered what, and what to do about it. Any other error is reported as
 * one fixed line, so a provider's response body never reaches a client.
 */
export class BillingStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingStatusError";
  }
}

/** Parse a JSON body; a non-JSON answer (a proxy page) is not echoed to clients. */
export async function readJson<T>(
  res: { json: () => Promise<unknown> },
  who: string
): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new BillingStatusError(`${who} returned an unreadable response.`);
  }
}
