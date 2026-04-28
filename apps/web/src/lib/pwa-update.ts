// Reload the app, unregistering any service workers so the next page
// load isn't served from a stale Workbox precache. CacheStorage is left
// in place — Workbox precache reconciliation can reuse unchanged assets
// on the next install, avoiding redundant downloads. If that turns out
// to be unreliable, fall back to clearCachesAndReload (the full nuke).
export async function reloadApp(): Promise<void> {
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    } catch {
      // fall through to reload
    }
  }
  window.location.reload();
}

// Heavier reset: unregister every SW and delete every CacheStorage
// entry. Used as the explicit "Clear cache & reload" escape hatch in
// the Updates panel for the cases where the lighter path leaves stale
// state behind.
export async function clearCachesAndReload(): Promise<void> {
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    } catch {
      // fall through
    }
  }
  if ("caches" in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      // fall through
    }
  }
  window.location.reload();
}

export function initPWAUpdate(): void {
  if (!import.meta.env.PROD) {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => {
          void registration.unregister();
        });
      });
    }
    return;
  }

  // Register the service worker so PWA install + offline support keep
  // working. Upgrade detection is handled separately via the
  // X-Dispatch-Version response header (see lib/version.ts) — we no
  // longer rely on vite-plugin-pwa's onNeedRefresh callback.
  const pwaModule = "virtual:pwa-register";
  void import(/* @vite-ignore */ pwaModule).then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
