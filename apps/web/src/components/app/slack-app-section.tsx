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

type Channel = { id: string; name: string; private: boolean };
type State = {
  status: string;
  configured: boolean;
  binding: { teamName: string; channelName: string; baseUrl: string } | null;
  channels: Channel[];
};
const endpoint = "/api/v1/notifications/slack-app";
const manifest = JSON.stringify(
  {
    display_information: { name: "Dispatch" },
    features: { bot_user: { display_name: "Dispatch", always_online: false } },
    oauth_config: {
      scopes: { bot: ["chat:write", "channels:read", "groups:read"] },
    },
    settings: { socket_mode_enabled: true },
  },
  null,
  2
);

export function SlackAppSection() {
  const client = useQueryClient();
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [validated, setValidated] = useState(false);
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["slack-app"],
    queryFn: () => api<State>(endpoint),
    refetchInterval: 10000,
  });
  const action = useMutation({
    mutationFn: async ({
      name,
      body = {},
    }: {
      name: string;
      body?: Record<string, unknown>;
    }) => {
      const result = await api<State & { teamName?: string }>(
        `${endpoint}/${name}`,
        { method: "POST", body: JSON.stringify(body) }
      );
      if (name === "validate") {
        setChannels(result.channels);
        setValidated(true);
        setMessage(`Validated ${result.teamName}. Choose a channel below.`);
      } else if (name === "refresh") {
        setChannels(result.channels);
        setChannelId((id) =>
          result.channels.some((channel) => channel.id === id) ? id : ""
        );
      } else {
        setMessage(
          name === "test"
            ? "Test delivered to Slack. This does not mean it was read."
            : name === "disconnect"
              ? "Disconnected and cleared credentials."
              : "Slack notifications enabled."
        );
        if (name !== "test") {
          setBotToken("");
          setAppToken("");
          setValidated(false);
          setChannelId("");
        }
      }
      await client.invalidateQueries({ queryKey: ["slack-app"] });
    },
  });
  const run = (name: string, body?: Record<string, unknown>) => {
    setMessage("");
    action.mutate({ name, body });
  };
  const editToken = () => {
    setValidated(false);
    setChannels([]);
    setChannelId("");
  };
  return (
    <section
      className="border-t border-border pt-8 space-y-4"
      aria-label="Slack app setup"
    >
      <div>
        <h3 className="text-sm font-medium">Slack app</h3>
        <p className="text-sm text-muted-foreground">
          Explicit notify tool alerts and one alert when a question is still
          unanswered after five minutes. No repeating reminders.
        </p>
      </div>
      <p className="text-sm" role="status">
        Connection:{" "}
        {query.data?.status.replaceAll("_", " ") ||
          (query.isError ? "unavailable" : "loading")}
        {query.data?.binding
          ? ` · ${query.data.binding.teamName} / #${query.data.binding.channelName}`
          : ""}
      </p>
      <details className="rounded border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Create and install your own Slack app
        </summary>
        <ol className="mt-3 list-decimal pl-5 text-sm space-y-3">
          <li>
            Open{" "}
            <a
              className="underline"
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              Slack app management
            </a>
            . Choose Create New App → From a manifest, select your workspace,
            and paste this manifest. Workspace admin approval may be required.
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
              {manifest}
            </pre>
          </li>
          <li>
            Basic Information → App-Level Tokens → Generate Token and Scopes.
            Add <code>connections:write</code>, generate, and copy the{" "}
            <code>xapp-</code> token into App token below.
          </li>
          <li>
            OAuth &amp; Permissions → Install to Workspace → Allow. Copy Bot
            User OAuth Token (<code>xoxb-</code>) into Bot token below. No
            client secret, callback URL, tunnel, or separate Slack process is
            needed.
          </li>
          <li>
            Invite the Dispatch app to your destination channel using Slack’s
            Add apps menu. Validate here, then select the channel by name.
            Private channels appear only after the app joins.
          </li>
        </ol>
      </details>
      <div className="max-w-lg space-y-3">
        <label className="block text-sm">
          App token
          <Input
            aria-label="App token"
            disabled={action.isPending}
            type="password"
            autoComplete="new-password"
            value={appToken}
            placeholder="xapp-…"
            onChange={(e) => {
              editToken();
              setAppToken(e.target.value);
            }}
          />
        </label>
        <label className="block text-sm">
          Bot token
          <Input
            aria-label="Bot token"
            disabled={action.isPending}
            type="password"
            autoComplete="new-password"
            value={botToken}
            placeholder="xoxb-…"
            onChange={(e) => {
              editToken();
              setBotToken(e.target.value);
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Credentials are stored in this Dispatch instance’s database, not
          encrypted at rest. Keep its host and backups private. Tokens are never
          returned by Settings. Use a trusted HTTPS connection when configuring
          a remote instance.
        </p>
        <Button
          disabled={action.isPending || !botToken || !appToken}
          onClick={() => run("validate", { botToken, appToken })}
        >
          Validate tokens
        </Button>
        {validated && (
          <>
            <Button
              variant="default"
              disabled={action.isPending}
              onClick={() => run("refresh")}
            >
              Refresh channels
            </Button>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger aria-label="Notification channel">
                <SelectValue placeholder="Choose a joined channel" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    #{channel.name}
                    {channel.private ? " (private)" : " (public)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {channels.length === 0 && (
              <p className="text-sm">
                Invite the app to a channel, then refresh.
              </p>
            )}
            <label className="block text-sm">
              Dispatch web URL
              <Input
                aria-label="Dispatch web URL"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Everyone in the selected channel can read posted question text and
              context. Links require LAN or VPN access. Selecting a channel
              grants no answer or approval authority.
            </p>
            <Button
              disabled={action.isPending || !channelId || !baseUrl}
              onClick={() => run("enable", { channelId, baseUrl })}
            >
              Enable in selected channel
            </Button>
          </>
        )}
        {query.data?.configured && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={action.isPending} onClick={() => run("test")}>
              Send test
            </Button>
            <Button
              variant="default"
              disabled={action.isPending}
              onClick={() => run("disconnect")}
            >
              Disconnect and clear tokens
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Dispatch connects outward to Slack. While this host is asleep or
          offline, messages cannot be delivered. A connection or delivery
          receipt does not mean you read a notification.
        </p>
        {action.error && (
          <p role="alert" className="text-sm text-destructive">
            {action.error.message}
          </p>
        )}
        {message && (
          <p className="text-sm" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
