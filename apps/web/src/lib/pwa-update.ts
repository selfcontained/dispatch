type Listener = () => void;
type UpdateSWFn = (reloadPage?: boolean) => Promise<void>;

const listeners = new Set<Listener>();
let needRefresh = false;
let updateSWFn: UpdateSWFn | null = null;

export function getNeedRefresh(): boolean {
  return needRefresh;
}

export function subscribeNeedRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function triggerSWUpdate(reloadPage = true): Promise<void> {
  if (updateSWFn) {
    await updateSWFn(reloadPage);
    return;
  }
  if (reloadPage) window.location.reload();
}

function fireNeedRefresh(): void {
  needRefresh = true;
  for (const listener of listeners) listener();
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
    updateSWFn = registerSW({
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
