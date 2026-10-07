export type NotifyEventType = "waiting_user" | "blocked";

export type NotificationSettingsResponse = {
  webhookUrl: string;
  notifyEvents: NotifyEventType[];
  webNotifyEnabled: boolean;
  webNotifyEvents: NotifyEventType[];
};

export const EVENT_OPTIONS: Array<{
  id: NotifyEventType;
  label: string;
  description: string;
}> = [
  {
    id: "waiting_user",
    label: "Waiting for input",
    description: "Agent needs your response",
  },
  {
    id: "blocked",
    label: "Blocked",
    description: "Agent is stuck with no further approach to try",
  },
];
