// Version mismatch detection.
//
// Vite injects __DISPATCH_VERSION__ at build time (see vite.config.ts)
// from the workspace package.json. The server stamps every API response
// with `X-Dispatch-Version` from the same source. When the api fetch
// helper observes a value that doesn't match the bundle's compiled-in
// version, this module flips into a "mismatch" state and notifies any
// subscribers — driving the reload banner.

export const BUILD_VERSION: string = __DISPATCH_VERSION__;

/**
 * The commit this bundle was built from, or null when it was built without
 * git. The version alone cannot see a redeploy that kept the same semver —
 * every branch build of `0.38.14` reports `0.38.14` — so an open tab sat on
 * stale code with no banner indefinitely, the service worker being
 * registered `prompt` and waiting to be told.
 */
export const BUILD_ID: string | null = __DISPATCH_BUILD__;

type Listener = () => void;
const listeners = new Set<Listener>();
let serverVersion: string | null = null;
let mismatch = false;
let dismissed = false;

export function getServerVersion(): string | null {
  return serverVersion;
}

export function isVersionMismatch(): boolean {
  return mismatch;
}

export function isVersionMismatchDismissed(): boolean {
  return dismissed;
}

export function dismissVersionMismatch(): void {
  if (dismissed) return;
  dismissed = true;
  notify();
}

// Listeners fire whenever the toast's input state (mismatch flag or
// dismissal) changes, so the component can stay in sync without owning
// any of it locally — important because the toast may unmount and
// remount (logout/login, Strict Mode double-mount, future layout
// changes) and dismissal needs to survive those.
export function subscribeVersionMismatch(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function noteServerVersion(version: string | null | undefined): void {
  if (!version) return;
  serverVersion = version;
  if (mismatch) return;
  if (version === BUILD_VERSION) return;
  mismatch = true;
  notify();
}

/**
 * The server's build id, from `X-Dispatch-Build`. Catches the redeploy the
 * version cannot: same semver, different code.
 *
 * Silent unless both sides know their build. A bundle or a server built
 * without git reports null, and treating that as a difference would strand
 * the client behind a banner that reloading can never clear.
 */
export function noteServerBuild(build: string | null | undefined): void {
  if (!build || !BUILD_ID) return;
  if (mismatch) return;
  if (build === BUILD_ID) return;
  mismatch = true;
  notify();
}

// Test/debug hook: lets Playwright (and humans poking around in
// devtools) simulate a mismatch without bouncing the server.
if (typeof window !== "undefined") {
  (
    window as unknown as {
      __dispatchTriggerVersionMismatch?: (version?: string) => void;
    }
  ).__dispatchTriggerVersionMismatch = (version = "dev-mismatch") => {
    noteServerVersion(version);
  };
}
