const EVENT_LABELS: Record<string, string> = {
  done: "finished",
  waiting_user: "needs your input",
  blocked: "is blocked",
};

/**
 * Show a browser notification for an agent event.
 * Only fires when the Notification API is available and permission is granted.
 */
export function showWebNotification(payload: {
  agentName: string;
  eventType: string;
  message: string;
}): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;

  const verb = EVENT_LABELS[payload.eventType] ?? payload.eventType;
  const title = `${payload.agentName} ${verb}`;

  new Notification(title, {
    body: payload.message,
    tag: `dispatch-${payload.agentName}-${payload.eventType}`,
    icon: getAppIconUrl(),
  });
}

/** Derive the app icon URL from the current page's apple-touch-icon link. */
function getAppIconUrl(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (link?.href) return link.href;
  return "/icons/teal/brand-icon-192.png";
}

/** Request notification permission from the browser. Returns the resulting permission state. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  return Notification.requestPermission();
}

/** Get the current notification permission state without prompting. */
export function getNotificationPermission(): NotificationPermission {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}
