type Listener = () => void;

const listeners = new Set<Listener>();
let needRefresh = false;

export function getNeedRefresh(): boolean {
  return needRefresh;
}

export function subscribeNeedRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function fireNeedRefresh(): void {
  needRefresh = true;
  for (const listener of listeners) listener();
}

function getPendingWorker(
  registration: ServiceWorkerRegistration
): ServiceWorker | null {
  return registration.installing ?? registration.waiting ?? null;
}

async function waitForPendingWorker(
  registration: ServiceWorkerRegistration,
  timeoutMs: number
): Promise<ServiceWorker | null> {
  const existing = getPendingWorker(registration);
  if (existing) return existing;
  return await new Promise<ServiceWorker | null>((resolve) => {
    const handleUpdateFound = (): void => {
      const pending = getPendingWorker(registration);
      if (pending) {
        cleanup();
        resolve(pending);
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      registration.removeEventListener("updatefound", handleUpdateFound);
    };
    registration.addEventListener("updatefound", handleUpdateFound);
    const timer = setTimeout(() => {
      const pending = getPendingWorker(registration);
      cleanup();
      resolve(pending);
    }, timeoutMs);
  });
}

// Compare ServiceWorker instances, not scriptURL: Workbox's SW has a stable
// URL (/sw.js) so the old and new workers share the same scriptURL string,
// and a URL equality check returns true the moment any active worker exists
// — including the old one.
async function waitForWorkerControl(
  worker: ServiceWorker,
  timeoutMs: number
): Promise<void> {
  if (navigator.serviceWorker.controller === worker) return;
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      cleanup();
      resolve();
    };
    const handleControllerChange = (): void => {
      if (navigator.serviceWorker.controller === worker) settle();
    };
    const handleStateChange = (): void => {
      if (worker.state === "redundant") settle();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange
      );
      worker.removeEventListener("statechange", handleStateChange);
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange
    );
    worker.addEventListener("statechange", handleStateChange);
    const timer = setTimeout(settle, timeoutMs);
  });
}

// Force the SW to fetch the newest bundle, activate it, and reload — used
// both when the user clicks Reload on the update toast (waiting SW already
// exists, polling fired onNeedRefresh) and right after a server-driven
// deploy (no waiting SW yet, polling hasn't ticked). vite-plugin-pwa's
// own `updateSW` does not call registration.update(), so the post-deploy
// path needs this explicit dance to avoid a stale precached reload.
export async function forcePWAUpdate(reloadPage = true): Promise<void> {
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        const pending = await waitForPendingWorker(registration, 3_000);
        if (pending) {
          if (registration.waiting) {
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
          }
          await waitForWorkerControl(pending, 10_000);
        }
      }
    } catch {
      // fall through to reload
    }
  }
  if (reloadPage) window.location.reload();
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
    (
      window as unknown as { __dispatchTriggerNeedRefresh: () => void }
    ).__dispatchTriggerNeedRefresh = fireNeedRefresh;
    return;
  }

  // Check for SW updates every 5 minutes so long-lived Safari tabs pick up
  // new deployments without a manual refresh.
  const intervalMS = 5 * 60 * 1000;
  // Dynamic import uses a variable so Vite's dep scanner skips it in dev
  // (the PWA plugin is only loaded in production builds).
  const pwaModule = "virtual:pwa-register";
  void import(/* @vite-ignore */ pwaModule).then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onNeedRefresh() {
        fireNeedRefresh();
      },
      onRegisteredSW(_swUrl: string, registration?: ServiceWorkerRegistration) {
        if (registration) {
          setInterval(() => {
            void registration.update();
          }, intervalMS);
        }
      },
    });
  });
}
