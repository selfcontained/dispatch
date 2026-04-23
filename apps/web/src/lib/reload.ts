// Wait for a worker to finish installing/activating so the reload that follows
// picks up the new precache instead of serving the old one.
async function waitForWorkerActivation(
  worker: ServiceWorker,
  timeoutMs: number
): Promise<void> {
  if (worker.state === "activated") return;
  await new Promise<void>((resolve) => {
    const handleChange = (): void => {
      if (worker.state === "activated" || worker.state === "redundant") {
        worker.removeEventListener("statechange", handleChange);
        resolve();
      }
    };
    worker.addEventListener("statechange", handleChange);
    setTimeout(() => {
      worker.removeEventListener("statechange", handleChange);
      resolve();
    }, timeoutMs);
  });
}

export async function reloadApp(): Promise<void> {
  // Force the service worker to check for a new version and wait for it to
  // install before reloading. Without this, autoUpdate's periodic update loop
  // may not have noticed the new SW yet, so the reload serves the old
  // precached bundle and the "update available" toast reappears immediately.
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        const pending = registration.installing ?? registration.waiting;
        if (pending) {
          // vite-plugin-pwa's autoUpdate already sets skipWaiting:true in the
          // SW itself, so a "waiting" worker is unusual — but post the message
          // anyway as a safety net for edge-case timings.
          if (registration.waiting) {
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
          }
          await waitForWorkerActivation(pending, 3000);
        }
      }
    } catch {
      // fall through to plain reload
    }
  }
  window.location.reload();
}
