import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

type Mode = "off" | "shadow" | "active";
type Status = {
  mode: Mode;
  modeSource: string;
  configured: boolean;
  keySource: string;
  storedKey: boolean;
  dailyCap: number;
};
const endpoint = "/api/v1/experiments/routing";
const queryKey = ["routing-experiment-settings"];
export function RoutingSettings(): JSX.Element {
  const [key, setKey] = useState("");
  const client = useQueryClient();
  const settings = useQuery({
    queryKey,
    queryFn: () => api<Status>(`${endpoint}/settings`),
  });
  const save = useMutation({
    mutationFn: (body: { mode?: Mode; apiKey?: string; removeKey?: boolean }) =>
      api<Status>(`${endpoint}/settings`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      setKey("");
      check.reset();
    },
  });
  const check = useMutation({
    mutationFn: () =>
      api<{ status: string; result?: { latencyMs?: number } }>(
        `${endpoint}/check`,
        { method: "POST" }
      ),
  });
  const data = settings.data;
  return (
    <section
      className="max-w-2xl space-y-5 p-4 md:p-6"
      aria-labelledby="routing-settings-heading"
    >
      <div>
        <h2 id="routing-settings-heading" className="text-lg font-semibold">
          AI thread routing
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Optional OpenAI Decisions experiment. Off sends nothing. Shadow
          records suggestions. Active can place a new turn under its initiating
          user post before output starts. Existing discussions and explicit
          routing stay authoritative.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        When enabled, bounded excerpts of incoming user text, its discussion
        anchor, and nearby user and assistant replies are sent to OpenAI.
        Attachments, files, and tool output are excluded. Diagnostics retain
        identifiers and suggestions, without copied conversation text.
      </p>
      {settings.isPending && <p role="status">Loading routing settings…</p>}
      {settings.error && (
        <p role="alert">
          Unable to load routing settings.{" "}
          <Button
            variant="default"
            size="sm"
            onClick={() => void settings.refetch()}
          >
            Try again
          </Button>
        </p>
      )}
      {data && (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="routing-mode">
              Routing mode
            </label>
            <Select
              value={data.mode}
              disabled={save.isPending || data.modeSource === "environment"}
              onValueChange={(mode) => save.mutate({ mode: mode as Mode })}
            >
              <SelectTrigger id="routing-mode" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="shadow">Shadow</SelectItem>
                <SelectItem value="active">Active</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {data.modeSource === "environment"
                ? "Mode is overridden by the server environment."
                : "Changes apply to new turns. Existing output stays in its frozen location."}
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="routing-api-key">
              Dedicated OpenAI API key
            </label>
            <p role="status" className="text-sm">
              {data.configured
                ? `Configured via ${data.keySource === "environment" ? "server environment" : "Settings"}.`
                : "No API key configured. No requests will be sent."}
            </p>
            <Input
              id="routing-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={key}
              maxLength={2048}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Enter a dedicated API key"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={save.isPending || key.trim().length < 10}
                onClick={() => save.mutate({ apiKey: key.trim() })}
              >
                {data.storedKey ? "Replace saved key" : "Save key"}
              </Button>
              <Button
                variant="default"
                disabled={save.isPending || !data.storedKey}
                onClick={() => save.mutate({ removeKey: true })}
              >
                Remove saved key
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Saved only in this server’s local Postgres settings, without
              application-level encryption. Protect database access and backups.
              The secret is never returned here. A server environment key takes
              precedence; removing a saved key does not remove that override.
            </p>
          </div>
          <div className="space-y-2 border-t border-border pt-4">
            <Button
              variant="default"
              disabled={!data.configured || check.isPending || save.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? "Checking connection…" : "Check connection"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Sends one fixed synthetic conversation, including while Off. Never
              sends your messages or enables routing. Counts toward the shared
              daily request cap of {data.dailyCap}; this cap is not a guaranteed
              dollar limit.
            </p>
            {check.data && (
              <p role="status" className="text-sm">
                {check.data.status === "ok"
                  ? `Connection succeeded${check.data.result?.latencyMs !== undefined ? ` (${check.data.result.latencyMs} ms)` : ""}.`
                  : `Connection check: ${check.data.status.replaceAll("_", " ")}.`}
              </p>
            )}
            {check.error && (
              <p role="alert" className="text-sm">
                Connection check unavailable. Try again explicitly when ready.
              </p>
            )}
          </div>
          {save.isSuccess && (
            <p role="status" className="text-sm">
              Routing settings saved.
            </p>
          )}
          {save.error && (
            <p role="alert" className="text-sm">
              Unable to save routing settings. Please try again.
            </p>
          )}
        </>
      )}
    </section>
  );
}
