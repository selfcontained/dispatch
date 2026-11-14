import { recordHTTPRequest } from "@/lib/energy-metrics";
import { noteServerVersion } from "@/lib/version";
import { APP_SESSION_ID } from "@/lib/app-session";

const PRESENCE_SESSION_HEADER = "x-dispatch-session";

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
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
  // Same precedence as before: caller headers replace the default ones.
  const headers = new Headers(
    init?.headers ??
      (hasBody && !isFormData ? { "content-type": "application/json" } : {})
  );
  // Names this tab, so the server can count what the user does as presence.
  headers.set(PRESENCE_SESSION_HEADER, APP_SESSION_ID);
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });

  noteServerVersion(res.headers.get("X-Dispatch-Version"));

  if (res.status === 401) {
    authEvents.dispatchEvent(new Event("unauthenticated"));
    throw new UnauthenticatedError();
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const payload = (await res.json()) as { error?: string; code?: string };
      code = payload.code;
      if (payload.error) {
        message = payload.error;
      }
    } catch {}
    throw new ApiError(res.status, message, code);
  }

  if (res.status === 204) {
    return null as T;
  }

  return (await res.json()) as T;
}
