const IOS_DEVICE_RE = /iPad|iPhone|iPod/i;

type StandaloneNavigator = Navigator & { standalone?: boolean };

function isIOSDevice(): boolean {
  return (
    IOS_DEVICE_RE.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
  );
}

export function isStandaloneApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as StandaloneNavigator).standalone === true
  );
}

export function isStandaloneIOSApp(): boolean {
  return isIOSDevice() && isStandaloneApp();
}

/**
 * Build a URL that, when opened from inside an iOS PWA, hands off to Safari.
 * The `x-safari-` scheme hack only resolves for `https:` URLs — passing an
 * `http:` URL produces "invalid link" on modern iOS. Returns null when no
 * reliable escape exists; callers should hide the external-open affordance
 * in that case.
 */
export function getSafariExternalHref(href: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(href, window.location.href);
  } catch {
    return null;
  }

  if (resolved.protocol !== "https:") return null;

  return `x-safari-${resolved.toString()}`;
}
