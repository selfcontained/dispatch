import { recordHTTPRequest } from "@/lib/energy-metrics";
import { noteServerVersion } from "@/lib/version";

/**
 * Lightweight event target for auth failures.  Components (or hooks) can
 * subscribe via `authEvents.addEventListener("unauthenticated", ...)` to
 * react when a 401 is received from any API call.
 */
export const authEvents = new EventTarget();

/**
 * Emitted when the server is reachable but cannot use its database. Keeping
 * this separate from generic request failures lets the app replace any open
 * route with the recovery UI immediately.
 */
export const availabilityEvents = new EventTarget();

export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

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
  const isFormData =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      ...(hasBody && !isFormData ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  noteServerVersion(res.headers.get("X-Dispatch-Version"));

  if (res.status === 401) {
    authEvents.dispatchEvent(new Event("unauthenticated"));
    throw new UnauthenticatedError();
  }

  if (res.status === 503) {
    let message = "Dispatch is waiting for its database.";
    try {
      const payload = (await res.clone().json()) as {
        error?: string;
        message?: string;
        detail?: string;
      };
      // `error` is a stable machine-readable API code. Prefer the human
      // message for the outage UI, then include a server detail only when no
      // message was supplied.
      message = payload.message ?? payload.detail ?? payload.error ?? message;
    } catch {}
    availabilityEvents.dispatchEvent(
      new CustomEvent("database-unavailable", { detail: { message } })
    );
    throw new DatabaseUnavailableError(message);
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
