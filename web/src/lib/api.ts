import { recordHTTPRequest } from "@/lib/energy-metrics";

/**
 * Lightweight event target for auth failures.  Components (or hooks) can
 * subscribe via `authEvents.addEventListener("unauthenticated", ...)` to
 * react when a 401 is received from any API call.
 */
export const authEvents = new EventTarget();

export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "UnauthenticatedError";
  }
}

/**
 * Shared fetch wrapper used by React Query queryFn / mutationFn
 * implementations as well as imperative callers (e.g. the terminal hook).
 *
 * On 401 it dispatches an "unauthenticated" event so the auth hook can
 * transition to the login screen.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  recordHTTPRequest();

  const hasBody = init?.body !== undefined && init?.body !== null;
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (res.status === 401) {
    authEvents.dispatchEvent(new Event("unauthenticated"));
    throw new UnauthenticatedError();
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {}
    throw new Error(message);
  }

  if (res.status === 204) {
    return null as T;
  }

  return (await res.json()) as T;
}
