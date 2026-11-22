import { SlackAppSection } from "./slack-app-section";
import { BrowserNotificationsSection } from "@/components/app/browser-notifications-section";
import {
  SoundCuesSection,
  TipsSection,
} from "@/components/app/notification-device-sections";
import { useNotificationSettings } from "@/components/app/use-notification-settings";
import { AsyncBoundary } from "@/components/ui/async-boundary";

export function NotificationSettings(): JSX.Element {
  const {
    loading,
    loadError,
    reload,
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

  return (
    <div className="flex flex-col gap-8 overflow-y-auto p-6">
      <SoundCuesSection />

      <div className="border-t border-border pt-8">
        <TipsSection />
      </div>

      <AsyncBoundary
        query={{
          data: loading || loadError ? undefined : true,
          error: loadError,
          isFetching: loading,
          refetch: reload,
        }}
        thing="browser notification settings"
      >
        {() => (
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
        )}
      </AsyncBoundary>

      <SlackAppSection />
    </div>
  );
}
