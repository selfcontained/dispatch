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

// The new worker takes over in two steps: it becomes registration.active
// (skipWaiting → activated), then — with clientsClaim, which vite-plugin-pwa's
// autoUpdate mode enables — it claims this page and becomes the controller.
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

type ReloadAppOptions = {
  waitForUpdate?: boolean;
};

export async function reloadApp(options: ReloadAppOptions = {}): Promise<void> {
  // vite-plugin-pwa's updateSW(true) is a no-op in autoUpdate mode and
  // neither mode triggers registration.update() on demand. Without this,
  // clicking Reload reloads before a new SW has installed, so the old
  // precached bundle is served and the toast reappears.
  if (options.waitForUpdate && "serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        const pending = await waitForPendingWorker(registration, 3_000);
        if (pending) {
          // autoUpdate sets skipWaiting:true so "waiting" is unusual, but
          // poke it anyway for edge-case timings.
          if (registration.waiting) {
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
          }
          await waitForWorkerControl(pending, 10_000);
        }
      }
    } catch {
      // fall through
    }
  }
  window.location.reload();
}
