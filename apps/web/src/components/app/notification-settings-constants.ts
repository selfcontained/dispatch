export type NotifyEventType = "done" | "waiting_user" | "blocked";

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
  { id: "done", label: "Done", description: "Agent finished its task" },
  {
    id: "waiting_user",
    label: "Waiting for input",
    description: "Agent needs your response",
  },
  {
    id: "blocked",
    label: "Blocked",
    description: "Agent hit an error or obstacle",
  },
];
