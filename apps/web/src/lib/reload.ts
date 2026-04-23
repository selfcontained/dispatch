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
  // vite-plugin-pwa's updateSW(true) is a no-op in autoUpdate mode and
  // neither mode triggers registration.update() on demand. Without this,
  // clicking Reload reloads before a new SW has installed, so the old
  // precached bundle is served and the toast reappears.
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        const pending = registration.installing ?? registration.waiting;
        if (pending) {
          // autoUpdate sets skipWaiting:true so "waiting" is unusual, but
          // poke it anyway for edge-case timings.
          if (registration.waiting) {
            registration.waiting.postMessage({ type: "SKIP_WAITING" });
          }
          // vite-plugin-pwa's "activated" handler auto-reloads when the new
          // SW activates. We wait so our fallback reload below doesn't fire
          // before the new SW is in control.
          await waitForWorkerActivation(pending, 3000);
        }
      }
    } catch {
      // fall through
    }
  }
  window.location.reload();
}
