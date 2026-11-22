import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  EVENT_OPTIONS,
  type NotifyEventType,
} from "@/components/app/notification-settings-constants";
import { Alert } from "@/components/ui/alert";
import { OptionCard, SettingRow } from "@/components/ui/setting-row";

type BrowserNotificationsSectionProps = {
  webNotifyEnabled: boolean;
  webNotifyEvents: NotifyEventType[];
  browserPermission: NotificationPermission;
  saving: boolean;
  webError: unknown;
  webMessage: string;
  onRequestPermission: () => void;
  onToggleWebNotifyEnabled: (checked: boolean) => void;
  onToggleWebEvent: (eventType: NotifyEventType) => void;
  onTestWebNotification: () => void;
};

export function BrowserNotificationsSection({
  webNotifyEnabled,
  webNotifyEvents,
  browserPermission,
  saving,
  webError,
  webMessage,
  onRequestPermission,
  onToggleWebNotifyEnabled,
  onToggleWebEvent,
  onTestWebNotification,
}: BrowserNotificationsSectionProps): JSX.Element {
  const notificationsSupported = typeof Notification !== "undefined";
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      (navigator as { standalone?: boolean }).standalone === true);
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  return (
    <div className="border-t border-border pt-8">
      <h3 className="mb-1.5 section-label">Browser Notifications</h3>
      <p className="mb-3 text-body-md text-muted-foreground">
        Get native desktop or mobile notifications when agents need attention.
      </p>

      {!notificationsSupported ? (
        <p className="text-body-md text-faint">
          Browser notifications are not supported in this browser.
          {isIOS && !isStandalone
            ? " On iOS/iPadOS, install Dispatch as a PWA (Add to Home Screen) to enable notifications."
            : ""}
        </p>
      ) : (
        <div className="max-w-lg space-y-4">
          {/* Permission status + grant button */}
          {browserPermission !== "granted" ? (
            <div className="flex items-center gap-3 rounded-sm border border-border px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-body-md text-foreground">
                  {browserPermission === "denied"
                    ? "Notifications blocked"
                    : "Permission required"}
                </div>
                <div className="text-body-sm text-muted-foreground">
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
                onClick={() => void onRequestPermission()}
              >
                Allow
              </Button>
            </div>
          ) : null}

          {/* Enable toggle */}
          <SettingRow
            label="Enable browser notifications"
            description={
              browserPermission === "granted"
                ? "Show notifications when agents change status"
                : "Grant permission above to enable"
            }
            disabled={browserPermission !== "granted"}
          >
            <Checkbox
              checked={webNotifyEnabled}
              disabled={browserPermission !== "granted" || saving}
              onCheckedChange={(checked) =>
                void onToggleWebNotifyEnabled(checked === true)
              }
              data-testid="web-notify-enabled"
            />
          </SettingRow>

          {/* Web event toggles */}
          {webNotifyEnabled && browserPermission === "granted" && (
            <div className="space-y-2 pl-1">
              <div className="text-body-sm text-muted-foreground">
                Notify on:
              </div>
              {EVENT_OPTIONS.map(({ id, label, description }) => (
                <OptionCard key={id} label={label} description={description}>
                  <Checkbox
                    checked={webNotifyEvents.includes(id)}
                    disabled={saving}
                    onCheckedChange={() => void onToggleWebEvent(id)}
                    data-testid={`web-notify-event-${id}`}
                  />
                </OptionCard>
              ))}
              <div className="pt-1">
                <Button
                  size="sm"
                  onClick={onTestWebNotification}
                  data-testid="test-web-notification"
                >
                  Send test
                </Button>
              </div>
            </div>
          )}
          {webError ? (
            <Alert title="Couldn’t save changes." error={webError} />
          ) : null}
          {webMessage ? (
            <p role="status" className="text-body-md text-success-ink">
              {webMessage}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
