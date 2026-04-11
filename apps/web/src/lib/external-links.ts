const IOS_DEVICE_RE = /iPad|iPhone|iPod/i;

type StandaloneNavigator = Navigator & { standalone?: boolean };

function isIOSDevice(): boolean {
  return IOS_DEVICE_RE.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

export function isStandaloneApp(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as StandaloneNavigator).standalone === true;
}

export function isStandaloneIOSApp(): boolean {
  return isIOSDevice() && isStandaloneApp();
}

export function getSafariExternalHref(href: string): string {
  let resolved: URL;
  try {
    resolved = new URL(href, window.location.href);
  } catch {
    return href;
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return resolved.toString();
  }

  return `x-safari-${resolved.toString()}`;
}
