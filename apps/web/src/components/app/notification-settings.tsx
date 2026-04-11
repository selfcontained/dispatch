import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "@/components/ui/external-link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

type NotifyEventType = "done" | "waiting_user" | "blocked";

type NotificationSettingsResponse = {
  webhookUrl: string;
  notifyEvents: NotifyEventType[];
};

const EVENT_OPTIONS: Array<{ id: NotifyEventType; label: string; description: string }> = [
  { id: "done", label: "Done", description: "Agent finished its task" },
  { id: "waiting_user", label: "Waiting for input", description: "Agent needs your response" },
  { id: "blocked", label: "Blocked", description: "Agent hit an error or obstacle" },
];

export function NotificationSettings(): JSX.Element {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [notifyEvents, setNotifyEvents] = useState<NotifyEventType[]>([
    "done",
    "waiting_user",
    "blocked",
  ]);
  const [savedEvents, setSavedEvents] = useState<NotifyEventType[]>([]);
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
      JSON.stringify([...savedEvents].sort());

  const handleSave = useCallback(async () => {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const data = await api<NotificationSettingsResponse>(
        "/api/v1/notifications/settings",
        {
          method: "POST",
          body: JSON.stringify({ webhookUrl, notifyEvents }),
        }
      );
      setSavedUrl(data.webhookUrl);
      setSavedEvents(data.notifyEvents);
      setWebhookUrl(data.webhookUrl);
      setNotifyEvents(data.notifyEvents);
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }, [webhookUrl, notifyEvents]);

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

  if (loading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    );
  }

  return (
    <div className="flex flex-col gap-8 overflow-y-auto p-6">
      {/* Slack Webhook */}
      <div>
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Slack Webhook
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Receive notifications in Slack when agents finish, need input, or get blocked.
          Create an{" "}
          <ExternalLink
            href="https://api.slack.com/messaging/webhooks"
            className="text-blue-400 hover:underline"
          >
            Incoming Webhook
          </ExternalLink>{" "}
          in your Slack workspace and paste the URL below.
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

      {/* Event toggles */}
      <div>
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Notify on
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
            {testing ? "Sending..." : "Send test"}
          </Button>
        </div>
      </div>
    </div>
  );
}
