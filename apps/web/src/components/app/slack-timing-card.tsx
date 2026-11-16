import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { NotificationSettingsResponse } from "@/components/app/notification-settings-constants";

const endpoint = "/api/v1/notifications/settings";
const queryKey = ["notification-settings"];

/** How long Slack waits before an alert, when away and when in Dispatch. */
export function SlackTimingCard(): JSX.Element {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => api<NotificationSettingsResponse>(endpoint),
  });
  // Edits in progress; null shows the saved value.
  const [away, setAway] = useState<string | null>(null);
  const [present, setPresent] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: {
      slackAwayDelaySeconds: number;
      slackPresentDelayMinutes: number;
    }) =>
      api<NotificationSettingsResponse>(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      setAway(null);
      setPresent(null);
    },
  });
  const awayValue = away ?? String(query.data?.slackAwayDelaySeconds ?? "");
  const presentValue =
    present ?? String(query.data?.slackPresentDelayMinutes ?? "");
  const dirty = away !== null || present !== null;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      slackAwayDelaySeconds: Number(awayValue),
      slackPresentDelayMinutes: Number(presentValue),
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Slack timing</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={onSubmit}
          className="flex flex-wrap items-end gap-4"
          aria-label="Slack timing"
        >
          <label className="grid gap-1.5 text-sm">
            <span>When away (seconds)</span>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={3600}
              step={1}
              required
              className="w-32"
              disabled={!query.data}
              value={awayValue}
              onChange={(event) => setAway(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>When in Dispatch (minutes)</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              step={1}
              required
              className="w-32"
              disabled={!query.data}
              value={presentValue}
              onChange={(event) => setPresent(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
        {save.isError && (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {save.error instanceof Error
              ? save.error.message
              : "Couldn't save Slack timing."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
