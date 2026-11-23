import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/web-notifications";
import { useAutoSave } from "@/hooks/use-auto-save";
import {
  EVENT_OPTIONS,
  type NotificationSettingsResponse,
  type NotifyEventType,
} from "@/components/app/notification-settings-constants";

type Saved = Pick<
  NotificationSettingsResponse,
  "webNotifyEnabled" | "webNotifyEvents"
>;
/** One per row: the switch, and each event it covers. */
export type WebNotifySetting = "enabled" | NotifyEventType;

export function useNotificationSettings() {
  const [saved, setSaved] = useState<Saved>({
    webNotifyEnabled: false,
    webNotifyEvents: ["waiting_user", "blocked"],
  });
  // What the server last confirmed, read by a save when its turn comes.
  const savedRef = useRef(saved);
  const adopt = useCallback((data: Saved) => {
    savedRef.current = {
      webNotifyEnabled: data.webNotifyEnabled,
      webNotifyEvents: data.webNotifyEvents,
    };
    setSaved(savedRef.current);
  }, []);
  const [browserPermission, setBrowserPermission] =
    useState<NotificationPermission>(getNotificationPermission());

  // Re-check permission when the user returns to this page (e.g. after
  // changing settings in iOS Settings or browser site settings).
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        setBrowserPermission(getNotificationPermission());
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const [loading, setLoading] = useState(true);
  const [webMessage, setWebMessage] = useState("");
  const [loadError, setLoadError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const data = await api<NotificationSettingsResponse>(
          "/api/v1/notifications/settings"
        );
        if (cancelled) return;
        adopt(data);
        setLoadError(undefined);
      } catch (err) {
        if (!cancelled) setLoadError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, adopt]);

  const autoSave = useAutoSave<boolean, WebNotifySetting>(
    async (setting, on) => {
      const { webNotifyEnabled, webNotifyEvents } = savedRef.current;
      const body: Saved =
        setting === "enabled"
          ? { webNotifyEnabled: on, webNotifyEvents }
          : {
              webNotifyEnabled,
              webNotifyEvents: on
                ? [...webNotifyEvents.filter((e) => e !== setting), setting]
                : webNotifyEvents.filter((e) => e !== setting),
            };
      adopt(
        await api<NotificationSettingsResponse>(
          "/api/v1/notifications/settings",
          { method: "POST", body: JSON.stringify(body) }
        )
      );
    }
  );
  const { save } = autoSave;

  const webNotifyEvents = EVENT_OPTIONS.map(({ id }) => id).filter((id) =>
    autoSave.value(id, saved.webNotifyEvents.includes(id))
  );

  const toggleWebEvent = async (event: NotifyEventType): Promise<void> => {
    setWebMessage("");
    await save(event, !webNotifyEvents.includes(event));
  };

  const toggleWebNotifyEnabled = async (checked: boolean): Promise<void> => {
    setWebMessage("");
    await save("enabled", checked);
  };

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
    setWebMessage("Test notification sent — check your browser!");
  }, []);

  return {
    loading,
    loadError,
    reload,
    // Web/browser notifications
    webNotifyEnabled: autoSave.value("enabled", saved.webNotifyEnabled),
    webNotifyEvents,
    browserPermission,
    toggleWebEvent,
    toggleWebNotifyEnabled,
    saveStatus: autoSave.status,
    handleRequestPermission,
    handleTestWebNotification,
    webMessage,
  };
}
