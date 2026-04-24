function isControllingWorker(
  worker: ServiceWorker,
  registration: ServiceWorkerRegistration
): boolean {
  const active = registration.active;
  const controller = navigator.serviceWorker.controller;
  const workerScript = worker.scriptURL;
  return Boolean(
    active &&
    active.scriptURL === workerScript &&
    (!controller || controller.scriptURL === workerScript)
  );
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

async function waitForWorkerControl(
  worker: ServiceWorker,
  registration: ServiceWorkerRegistration,
  timeoutMs: number
): Promise<void> {
  if (isControllingWorker(worker, registration)) return;
  await new Promise<void>((resolve) => {
    const hasExistingController = navigator.serviceWorker.controller !== null;
    const handleChange = (): void => {
      if (worker.state === "redundant") {
        cleanup();
        resolve();
        return;
      }
      if (isControllingWorker(worker, registration)) {
        cleanup();
        resolve();
        return;
      }
      // On a first install there may be no existing controller to swap out,
      // so the best available signal is that the fetched worker activated.
      if (!hasExistingController && worker.state === "activated") {
        cleanup();
        resolve();
      }
    };
    const handleControllerChange = (): void => {
      if (isControllingWorker(worker, registration)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", handleChange);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange
      );
    };
    worker.addEventListener("statechange", handleChange);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange
    );
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
  });
}

export async function reloadApp(): Promise<void> {
  // vite-plugin-pwa's updateSW(true) is a no-op in autoUpdate mode and
  // neither mode triggers registration.update() on demand. Without this,
  // clicking Reload reloads before a new SW has installed, so the old
  // precached bundle is served and the toast reappears.
  if ("serviceWorker" in navigator) {
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
          // vite-plugin-pwa's "activated" handler auto-reloads when the new
          // SW activates. We wait for the worker to actually control this page
          // so our fallback reload below doesn't race the controller handoff.
          await waitForWorkerControl(pending, registration, 10_000);
        }
      }
    } catch {
      // fall through
    }
  }
  window.location.reload();
}
