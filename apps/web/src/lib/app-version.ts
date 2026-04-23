const BUILD_VERSION = __APP_VERSION__;

type Listener = (serverVersion: string) => void;
const listeners = new Set<Listener>();
let lastReported: string | null = null;

export function getBuildVersion(): string {
  return BUILD_VERSION;
}

export function reportServerVersion(version: string): void {
  const trimmed = version.trim();
  if (!trimmed || trimmed === lastReported) return;
  lastReported = trimmed;
  for (const listener of listeners) listener(trimmed);
}

export function subscribeServerVersion(listener: Listener): () => void {
  listeners.add(listener);
  if (lastReported) listener(lastReported);
  return () => {
    listeners.delete(listener);
  };
}

export function isUpdateAvailable(serverVersion: string): boolean {
  return Boolean(serverVersion) && serverVersion !== BUILD_VERSION;
}

if (import.meta.env.DEV) {
  (
    window as unknown as { __dispatchReportVersion: typeof reportServerVersion }
  ).__dispatchReportVersion = reportServerVersion;
}
