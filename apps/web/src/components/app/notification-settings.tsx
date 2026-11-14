import { SlackAppSection } from "./slack-app-section";
import { BrowserNotificationsSection } from "@/components/app/browser-notifications-section";
import {
  SoundCuesSection,
  TipsSection,
} from "@/components/app/notification-device-sections";
import { useNotificationSettings } from "@/components/app/use-notification-settings";

export function NotificationSettings(): JSX.Element {
  const {
    loading,
    webNotifyEnabled,
    webNotifyEvents,
    browserPermission,
    toggleWebEvent,
    toggleWebNotifyEnabled,
    handleRequestPermission,
    handleTestWebNotification,
    saving,
    webMessage,
    webError,
  } = useNotificationSettings();

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-8 overflow-y-auto p-6">
      <SoundCuesSection />

      <div className="border-t border-border pt-8">
        <TipsSection />
      </div>

      <BrowserNotificationsSection
        webNotifyEnabled={webNotifyEnabled}
        webNotifyEvents={webNotifyEvents}
        browserPermission={browserPermission}
        saving={saving}
        webError={webError}
        webMessage={webMessage}
        onRequestPermission={handleRequestPermission}
        onToggleWebNotifyEnabled={toggleWebNotifyEnabled}
        onToggleWebEvent={toggleWebEvent}
        onTestWebNotification={handleTestWebNotification}
      />

      <SlackAppSection />
    </div>
  );
}
