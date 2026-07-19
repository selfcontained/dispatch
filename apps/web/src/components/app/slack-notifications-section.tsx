import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  EVENT_OPTIONS,
  type NotifyEventType,
} from "@/components/app/notification-settings-constants";

type SlackNotificationsSectionProps = {
  webhookUrl: string;
  webNotifyEnabled: boolean;
  notifyEvents: NotifyEventType[];
  saving: boolean;
  testing: boolean;
  hasChanges: boolean;
  message: string;
  error: string;
  onWebhookUrlChange: (value: string) => void;
  onToggleEvent: (eventType: NotifyEventType) => void;
  onSave: () => void;
  onTest: () => void;
};

export function SlackNotificationsSection({
  webhookUrl,
  webNotifyEnabled,
  notifyEvents,
  saving,
  testing,
  hasChanges,
  message,
  error,
  onWebhookUrlChange,
  onToggleEvent,
  onSave,
  onTest,
}: SlackNotificationsSectionProps): JSX.Element {
  return (
    <>
      {/* Slack Webhook */}
      <div className="border-t border-border pt-8">
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Slack Webhook
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Receive notifications in Slack when agents finish, need input, or get
          blocked.
          {webNotifyEnabled && (
            <>
              {" "}
              When browser notifications are active, Slack is used as a fallback
              for when the app is closed.
            </>
          )}
          {!webNotifyEnabled && (
            <>
              {" "}
              Create an{" "}
              <a
                href="https://api.slack.com/messaging/webhooks"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Incoming Webhook
              </a>{" "}
              in your Slack workspace and paste the URL below.
            </>
          )}
        </p>
        <div className="max-w-lg space-y-3">
          <Input
            type="url"
            placeholder="https://hooks.slack.com/services/..."
            value={webhookUrl}
            onChange={(e) => onWebhookUrlChange(e.target.value)}
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
                onCheckedChange={() => onToggleEvent(id)}
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
            onClick={() => void onSave()}
            data-testid="save-notification-settings"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="default"
            disabled={testing || !webhookUrl}
            onClick={() => void onTest()}
            data-testid="test-slack-webhook"
          >
            {testing ? "Sending..." : "Send Slack test"}
          </Button>
        </div>
      </div>
    </>
  );
}
