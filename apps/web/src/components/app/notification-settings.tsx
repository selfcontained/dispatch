import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/web-notifications";

type NotifyEventType = "done" | "waiting_user" | "blocked";

type NotificationSettingsResponse = {
  webhookUrl: string;
  notifyEvents: NotifyEventType[];
  webNotifyEnabled: boolean;
  webNotifyEvents: NotifyEventType[];
};

const EVENT_OPTIONS: Array<{ id: NotifyEventType; label: string; description: string }> = [
  { id: "done", label: "Done", description: "Agent finished its task" },
  { id: "waiting_user", label: "Waiting for input", description: "Agent needs your response" },
  { id: "blocked", label: "Blocked", description: "Agent hit an error or obstacle" },
];

export function NotificationSettings(): JSX.Element {
  // Slack settings
  const [webhookUrl, setWebhookUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [notifyEvents, setNotifyEvents] = useState<NotifyEventType[]>([
    "done",
    "waiting_user",
    "blocked",
  ]);
  const [savedEvents, setSavedEvents] = useState<NotifyEventType[]>([]);

  // Web notification settings
  const [webNotifyEnabled, setWebNotifyEnabled] = useState(false);
  const [savedWebEnabled, setSavedWebEnabled] = useState(false);
  const [webNotifyEvents, setWebNotifyEvents] = useState<NotifyEventType[]>([
    "done",
    "waiting_user",
    "blocked",
  ]);
  const [savedWebEvents, setSavedWebEvents] = useState<NotifyEventType[]>([]);
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission>(
    getNotificationPermission()
  );

  // Re-check permission when the user returns to this page (e.g. after
  // changing settings in iOS Settings or browser site settings).
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        setBrowserPermission(getNotificationPermission());
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<NotificationSettingsResponse>(
          "/api/v1/notifications/settings"
        );
        if (cancelled) return;
        setWebhookUrl(data.webhookUrl);
        setSavedUrl(data.webhookUrl);
        setNotifyEvents(data.notifyEvents);
        setSavedEvents(data.notifyEvents);
        setWebNotifyEnabled(data.webNotifyEnabled);
        setSavedWebEnabled(data.webNotifyEnabled);
        setWebNotifyEvents(data.webNotifyEvents);
        setSavedWebEvents(data.webNotifyEvents);
      } catch {
        // ignore — first load may fail if server is starting
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasChanges =
    webhookUrl !== savedUrl ||
    JSON.stringify([...notifyEvents].sort()) !==
      JSON.stringify([...savedEvents].sort()) ||
    webNotifyEnabled !== savedWebEnabled ||
    JSON.stringify([...webNotifyEvents].sort()) !==
      JSON.stringify([...savedWebEvents].sort());

  const handleSave = useCallback(async () => {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const data = await api<NotificationSettingsResponse>(
        "/api/v1/notifications/settings",
        {
          method: "POST",
          body: JSON.stringify({
            webhookUrl,
            notifyEvents,
            webNotifyEnabled,
            webNotifyEvents,
          }),
        }
      );
      setSavedUrl(data.webhookUrl);
      setSavedEvents(data.notifyEvents);
      setWebhookUrl(data.webhookUrl);
      setNotifyEvents(data.notifyEvents);
      setSavedWebEnabled(data.webNotifyEnabled);
      setSavedWebEvents(data.webNotifyEvents);
      setWebNotifyEnabled(data.webNotifyEnabled);
      setWebNotifyEvents(data.webNotifyEvents);
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }, [webhookUrl, notifyEvents, webNotifyEnabled, webNotifyEvents]);

  const persistWebNotificationSettings = useCallback(async (
    nextEnabled: boolean,
    nextEvents: NotifyEventType[]
  ): Promise<boolean> => {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const data = await api<NotificationSettingsResponse>(
        "/api/v1/notifications/settings",
        {
          method: "POST",
          body: JSON.stringify({
            webNotifyEnabled: nextEnabled,
            webNotifyEvents: nextEvents,
          }),
        }
      );
      setSavedWebEnabled(data.webNotifyEnabled);
      setSavedWebEvents(data.webNotifyEvents);
      setWebNotifyEnabled(data.webNotifyEnabled);
      setWebNotifyEvents(data.webNotifyEvents);
      setMessage("Browser notification settings saved.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save browser notifications.");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const handleTest = useCallback(async () => {
    setError("");
    setMessage("");
    setTesting(true);
    try {
      const result = await api<{ ok: boolean; error?: string }>(
        "/api/v1/notifications/test",
        {
          method: "POST",
          body: JSON.stringify({ webhookUrl: webhookUrl || undefined }),
        }
      );
      if (result.ok) {
        setMessage("Test message sent — check your Slack channel!");
      } else {
        setError(result.error ?? "Test failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test.");
    } finally {
      setTesting(false);
    }
  }, [webhookUrl]);

  const toggleEvent = useCallback((eventType: NotifyEventType) => {
    setNotifyEvents((prev) =>
      prev.includes(eventType)
        ? prev.filter((e) => e !== eventType)
        : [...prev, eventType]
    );
  }, []);

  const toggleWebEvent = useCallback(async (eventType: NotifyEventType) => {
    const previousEnabled = webNotifyEnabled;
    const previousEvents = webNotifyEvents;
    const nextEvents = previousEvents.includes(eventType)
      ? previousEvents.filter((e) => e !== eventType)
      : [...previousEvents, eventType];

    setWebNotifyEvents(nextEvents);
    const saved = await persistWebNotificationSettings(previousEnabled, nextEvents);
    if (!saved) {
      setWebNotifyEnabled(previousEnabled);
      setWebNotifyEvents(previousEvents);
    }
  }, [persistWebNotificationSettings, webNotifyEnabled, webNotifyEvents]);

  const toggleWebNotifyEnabled = useCallback(async (checked: boolean) => {
    const previousEnabled = webNotifyEnabled;
    const previousEvents = webNotifyEvents;
    const nextEnabled = checked;

    setWebNotifyEnabled(nextEnabled);
    const saved = await persistWebNotificationSettings(nextEnabled, previousEvents);
    if (!saved) {
      setWebNotifyEnabled(previousEnabled);
      setWebNotifyEvents(previousEvents);
    }
  }, [persistWebNotificationSettings, webNotifyEnabled, webNotifyEvents]);

  const handleRequestPermission = useCallback(async () => {
    const result = await requestNotificationPermission();
    setBrowserPermission(result);
  }, []);

  const handleTestWebNotification = useCallback(() => {
    if (Notification.permission !== "granted") return;
    new Notification("Dispatch test notification", {
      body: "Browser notifications are working!",
      tag: "dispatch-test",
    });
    setMessage("Test notification sent — check your browser!");
  }, []);

  if (loading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    );
  }

  const notificationsSupported = typeof Notification !== "undefined";
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  return (
    <div className="flex flex-col gap-8 overflow-y-auto p-6">
      {/* Browser Notifications */}
      <div>
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Browser Notifications
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Get native desktop or mobile notifications when agents need attention.
          When enabled and the app is open, browser notifications are used instead of Slack.
        </p>

        {!notificationsSupported ? (
          <p className="text-sm text-muted-foreground/70">
            Browser notifications are not supported in this browser.
            {isIOS && !isStandalone
              ? " On iOS/iPadOS, install Dispatch as a PWA (Add to Home Screen) to enable notifications."
              : ""}
          </p>
        ) : (
          <div className="max-w-lg space-y-4">
            {/* Permission status + grant button */}
            {browserPermission !== "granted" ? (
              <div className="flex items-center gap-3 rounded border border-border px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">
                    {browserPermission === "denied" ? "Notifications blocked" : "Permission required"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {browserPermission === "denied"
                      ? isIOS
                        ? "Open device Settings > Notifications > Dispatch to enable, or tap Allow to re-request"
                        : "Update the notification permission in your browser settings, or tap Allow to re-request"
                      : isIOS
                        ? "Tap Allow, then confirm in the system prompt"
                        : "Your browser needs permission to show notifications"}
                  </div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleRequestPermission()}
                >
                  Allow
                </Button>
              </div>
            ) : null}

            {/* Enable toggle */}
            <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
              <Checkbox
                checked={webNotifyEnabled}
                disabled={browserPermission !== "granted" || saving}
                onCheckedChange={(checked) => void toggleWebNotifyEnabled(checked === true)}
                data-testid="web-notify-enabled"
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  Enable browser notifications
                </div>
                <div className="text-xs text-muted-foreground">
                  {browserPermission === "granted"
                    ? "Show notifications when agents change status"
                    : "Grant permission above to enable"}
                </div>
              </div>
            </label>

            {/* Web event toggles */}
            {webNotifyEnabled && browserPermission === "granted" && (
              <div className="space-y-2 pl-1">
                <div className="text-xs text-muted-foreground">Notify on:</div>
                {EVENT_OPTIONS.map(({ id, label, description }) => (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={webNotifyEvents.includes(id)}
                      disabled={saving}
                      onCheckedChange={() => void toggleWebEvent(id)}
                      data-testid={`web-notify-event-${id}`}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {label}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {description}
                      </div>
                    </div>
                  </label>
                ))}
                <div className="pt-1">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleTestWebNotification}
                    data-testid="test-web-notification"
                  >
                    Send test
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Slack Webhook */}
      <div className="border-t border-border pt-8">
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Slack Webhook
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Receive notifications in Slack when agents finish, need input, or get blocked.
          {webNotifyEnabled && (
            <> When browser notifications are active, Slack is used as a fallback for when the app is closed.</>
          )}
          {!webNotifyEnabled && (
            <>{" "}Create an{" "}
              <a
                href="https://api.slack.com/messaging/webhooks"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Incoming Webhook
              </a>{" "}
              in your Slack workspace and paste the URL below.</>
          )}
        </p>
        <div className="max-w-lg space-y-3">
          <Input
            type="url"
            placeholder="https://hooks.slack.com/services/..."
            value={webhookUrl}
            onChange={(e) => {
              setWebhookUrl(e.target.value);
              setMessage("");
              setError("");
            }}
            data-testid="slack-webhook-url"
          />
        </div>
      </div>

      {/* Slack Event toggles */}
      <div>
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Slack notify on
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Choose which agent status changes trigger a Slack notification.
        </p>
        <div className="max-w-lg space-y-2">
          {EVENT_OPTIONS.map(({ id, label, description }) => (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
            >
              <Checkbox
                checked={notifyEvents.includes(id)}
                onCheckedChange={() => toggleEvent(id)}
                data-testid={`notify-event-${id}`}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {label}
                </div>
                <div className="text-xs text-muted-foreground">
                  {description}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="max-w-lg">
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
        {message && (
          <p className="mb-3 text-sm text-status-working">{message}</p>
        )}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={saving || !hasChanges}
            onClick={() => void handleSave()}
            data-testid="save-notification-settings"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="default"
            disabled={testing || !webhookUrl}
            onClick={() => void handleTest()}
            data-testid="test-slack-webhook"
          >
            {testing ? "Sending..." : "Send Slack test"}
          </Button>
        </div>
      </div>
    </div>
  );
}
