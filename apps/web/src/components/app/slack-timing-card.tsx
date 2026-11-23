import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { NotificationSettingsResponse } from "@/components/app/notification-settings-constants";
import { LoadError } from "@/components/ui/async-boundary";
import { SettingRow } from "@/components/ui/setting-row";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTextSetting } from "@/hooks/use-text-setting";

const endpoint = "/api/v1/notifications/settings";
const queryKey = ["notification-settings"];

type Delay = "slackAwayDelaySeconds" | "slackPresentDelayMinutes";

const wholeNumber = (min: number, max: number) => (value: string) => {
  const number = Number(value);
  return value !== "" &&
    Number.isInteger(number) &&
    number >= min &&
    number <= max
    ? undefined
    : `Enter ${min} to ${max}.`;
};
const validAway = wholeNumber(0, 3600);
const validPresent = wholeNumber(1, 240);

/** How long Slack waits before an alert, when away and when in Dispatch. */
export function SlackTimingCard(): JSX.Element {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => api<NotificationSettingsResponse>(endpoint),
  });
  const autoSave = useAutoSave<string, Delay>(async (name, value) => {
    const saved = await api<NotificationSettingsResponse>(endpoint, {
      method: "POST",
      body: JSON.stringify({ [name]: Number(value) }),
    });
    client.setQueryData(queryKey, saved);
  });
  const away = useTextSetting({
    name: "slackAwayDelaySeconds",
    saved: String(query.data?.slackAwayDelaySeconds ?? ""),
    autoSave,
    validate: validAway,
  });
  const present = useTextSetting({
    name: "slackPresentDelayMinutes",
    saved: String(query.data?.slackPresentDelayMinutes ?? ""),
    autoSave,
    validate: validPresent,
  });
  return (
    <>
      <SettingRow
        layout="field"
        label="When away (seconds)"
        description="How long Slack waits before an alert when you’re away."
        error={away.problem}
        status={away.status}
      >
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          max={3600}
          step={1}
          disabled={!query.data}
          {...away.inputProps}
        />
      </SettingRow>
      <SettingRow
        layout="field"
        label="When in Dispatch (minutes)"
        description="How long it waits when you have Dispatch open."
        error={present.problem}
        status={present.status}
      >
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={240}
          step={1}
          disabled={!query.data}
          {...present.inputProps}
        />
      </SettingRow>
      {query.isError && (
        <LoadError
          thing="Slack timing"
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      )}
    </>
  );
}
