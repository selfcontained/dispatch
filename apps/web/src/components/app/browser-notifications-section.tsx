import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  EVENT_OPTIONS,
  type NotifyEventType,
} from "@/components/app/notification-settings-constants";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/components/app/settings-layout";
import type { WebNotifySetting } from "@/components/app/use-notification-settings";
import {
  OptionCard,
  SettingRow,
  type SaveStatus,
} from "@/components/ui/setting-row";

type BrowserNotificationsSectionProps = {
  webNotifyEnabled: boolean;
  webNotifyEvents: NotifyEventType[];
  browserPermission: NotificationPermission;
  saveStatus: (setting: WebNotifySetting) => SaveStatus;
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
  saveStatus,
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
    <SettingsGroup
      title="Browser notifications"
      description="Get native desktop or mobile notifications when agents need attention."
    >
      {!notificationsSupported ? (
        <p className="text-body-md text-faint">
          Browser notifications are not supported in this browser.
          {isIOS && !isStandalone
            ? " On iOS/iPadOS, install Dispatch as a PWA (Add to Home Screen) to enable notifications."
            : ""}
        </p>
      ) : (
        <>
          {/* Permission status + grant button */}
          {browserPermission !== "granted" ? (
            <SettingRow
              layout="action"
              label={
                browserPermission === "denied"
                  ? "Notifications blocked"
                  : "Permission required"
              }
              description={
                browserPermission === "denied"
                  ? isIOS
                    ? "Open device Settings > Notifications > Dispatch to enable, or tap Allow to re-request"
                    : "Update the notification permission in your browser settings, or tap Allow to re-request"
                  : isIOS
                    ? "Tap Allow, then confirm in the system prompt"
                    : "Your browser needs permission to show notifications"
              }
            >
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onRequestPermission()}
              >
                Allow
              </Button>
            </SettingRow>
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
            status={saveStatus("enabled")}
          >
            <Switch
              checked={webNotifyEnabled}
              disabled={browserPermission !== "granted"}
              onCheckedChange={(checked) =>
                void onToggleWebNotifyEnabled(checked)
              }
              data-testid="web-notify-enabled"
            />
          </SettingRow>

          {/* Web event toggles */}
          {webNotifyEnabled && browserPermission === "granted" && (
            <div className="space-y-2">
              <div className="text-body-sm text-muted-foreground">
                Notify on:
              </div>
              {EVENT_OPTIONS.map(({ id, label, description }) => (
                <OptionCard
                  key={id}
                  label={label}
                  description={description}
                  status={saveStatus(id)}
                >
                  <Checkbox
                    checked={webNotifyEvents.includes(id)}
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
          {webMessage ? (
            <p role="status" className="text-body-md text-success-ink">
              {webMessage}
            </p>
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}
