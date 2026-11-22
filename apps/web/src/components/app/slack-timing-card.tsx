import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { NotificationSettingsResponse } from "@/components/app/notification-settings-constants";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { Field } from "@/components/ui/field";

const endpoint = "/api/v1/notifications/settings";
const queryKey = ["notification-settings"];

function inRange(value: string, min: number, max: number): boolean {
  const number = Number(value);
  return (
    value.trim() !== "" &&
    Number.isInteger(number) &&
    number >= min &&
    number <= max
  );
}

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
  const [invalid, setInvalid] = useState<{ away?: string; present?: string }>(
    {}
  );
  const dirty = away !== null || present !== null;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const missing = {
      away: inRange(awayValue, 0, 3600) ? undefined : "Enter 0 to 3600.",
      present: inRange(presentValue, 1, 240) ? undefined : "Enter 1 to 240.",
    };
    setInvalid(missing);
    if (missing.away || missing.present) return;
    save.mutate({
      slackAwayDelaySeconds: Number(awayValue),
      slackPresentDelayMinutes: Number(presentValue),
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-heading-md">Slack timing</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-wrap items-start gap-4 [&>button]:mt-[1.375rem]"
          aria-label="Slack timing"
        >
          <Field label="When away (seconds)" error={invalid.away}>
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
              onChange={(event) => {
                setAway(event.target.value);
                setInvalid((current) => ({ ...current, away: undefined }));
              }}
            />
          </Field>
          <Field label="When in Dispatch (minutes)" error={invalid.present}>
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
              onChange={(event) => {
                setPresent(event.target.value);
                setInvalid((current) => ({ ...current, present: undefined }));
              }}
            />
          </Field>
          <Button type="submit" pending={save.isPending} disabled={!dirty}>
            Save
          </Button>
        </form>
        {query.isError && (
          <LoadError
            thing="Slack timing"
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
            className="mt-3"
          />
        )}
        {save.isError && (
          <Alert
            title="Couldn’t save changes."
            error={save.error}
            className="mt-3"
          />
        )}
      </CardContent>
    </Card>
  );
}
