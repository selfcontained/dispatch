import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/web-notifications";
import type {
  NotificationSettingsResponse,
  NotifyEventType,
} from "@/components/app/notification-settings-constants";

export function useNotificationSettings() {
  // Web notification settings
  const [webNotifyEnabled, setWebNotifyEnabled] = useState(false);
  const [savedWebEnabled, setSavedWebEnabled] = useState(false);
  const [webNotifyEvents, setWebNotifyEvents] = useState<NotifyEventType[]>([
    "waiting_user",
    "blocked",
  ]);
  const [savedWebEvents, setSavedWebEvents] = useState<NotifyEventType[]>([]);
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
  const [saving, setSaving] = useState(false);
  const [webMessage, setWebMessage] = useState("");
  const [webError, setWebError] = useState("");
  const webNotifyEnabledRef = useRef(webNotifyEnabled);
  const webNotifyEventsRef = useRef(webNotifyEvents);
  const savedWebEnabledRef = useRef(savedWebEnabled);
  const savedWebEventsRef = useRef(savedWebEvents);
  const webSaveRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<NotificationSettingsResponse>(
          "/api/v1/notifications/settings"
        );
        if (cancelled) return;
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

  useEffect(() => {
    webNotifyEnabledRef.current = webNotifyEnabled;
    webNotifyEventsRef.current = webNotifyEvents;
    savedWebEnabledRef.current = savedWebEnabled;
    savedWebEventsRef.current = savedWebEvents;
  }, [savedWebEnabled, savedWebEvents, webNotifyEnabled, webNotifyEvents]);

  const persistWebNotificationSettings = useCallback(
    async (
      nextEnabled: boolean,
      nextEvents: NotifyEventType[]
    ): Promise<boolean> => {
      const requestId = webSaveRequestIdRef.current + 1;
      webSaveRequestIdRef.current = requestId;
      setWebError("");
      setWebMessage("");
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
        if (webSaveRequestIdRef.current !== requestId) {
          return true;
        }
        setSavedWebEnabled(data.webNotifyEnabled);
        setSavedWebEvents(data.webNotifyEvents);
        setWebNotifyEnabled(data.webNotifyEnabled);
        setWebNotifyEvents(data.webNotifyEvents);
        setWebMessage("Browser notification settings saved.");
        return true;
      } catch (err) {
        if (webSaveRequestIdRef.current !== requestId) {
          return true;
        }
        setWebError(
          err instanceof Error
            ? err.message
            : "Failed to save browser notifications."
        );
        return false;
      } finally {
        if (webSaveRequestIdRef.current === requestId) {
          setSaving(false);
        }
      }
    },
    []
  );

  const toggleWebEvent = useCallback(
    async (eventType: NotifyEventType) => {
      const previousEnabled = webNotifyEnabledRef.current;
      const previousEvents = webNotifyEventsRef.current;
      const nextEvents = previousEvents.includes(eventType)
        ? previousEvents.filter((e) => e !== eventType)
        : [...previousEvents, eventType];

      setWebNotifyEvents(nextEvents);
      const saved = await persistWebNotificationSettings(
        previousEnabled,
        nextEvents
      );
      if (!saved) {
        setWebNotifyEnabled(savedWebEnabledRef.current);
        setWebNotifyEvents(savedWebEventsRef.current);
      }
    },
    [persistWebNotificationSettings]
  );

  const toggleWebNotifyEnabled = useCallback(
    async (checked: boolean) => {
      const previousEvents = webNotifyEventsRef.current;
      const nextEnabled = checked;

      setWebNotifyEnabled(nextEnabled);
      const saved = await persistWebNotificationSettings(
        nextEnabled,
        previousEvents
      );
      if (!saved) {
        setWebNotifyEnabled(savedWebEnabledRef.current);
        setWebNotifyEvents(savedWebEventsRef.current);
      }
    },
    [persistWebNotificationSettings]
  );

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
    // Web/browser notifications
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
  };
}
