import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Hash,
  KeyRound,
  Radio,
  Unplug,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  Panel,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { SettingsGroup } from "@/components/app/settings-layout";
import { cn } from "@/lib/utils";
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
import { SlackAnswerersCard, type SlackAnswerer } from "./slack-answerers-card";
import { SlackTimingCard } from "./slack-timing-card";
import { statusLabel } from "@/lib/status-label";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Field } from "@/components/ui/field";

type Channel = { id: string; name: string; private: boolean };
type State = {
  status: string;
  configured: boolean;
  binding: { teamName: string; channelName: string; baseUrl: string } | null;
  channels: Channel[];
  answerers?: SlackAnswerer[];
  missingLinkScopes?: string[] | null;
  missingImageScopes?: string[] | null;
  callbackDiagnostic?: { stage: string; at: string } | null;
  missingAnswerScopes?: string[] | null;
  linkOrigins?: {
    options: { url: string; loopback: boolean }[];
    defaultUrl: string | null;
  };
};
const endpoint = "/api/v1/notifications/slack-app";
export const manifest = JSON.stringify(
  {
    display_information: { name: "Dispatch" },
    features: { bot_user: { display_name: "Dispatch", always_online: false } },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "chat:write.customize",
          "channels:read",
          "groups:read",
          "channels:history",
          "groups:history",
          "files:write",
          "files:read",
          "reactions:write",
          "reactions:read",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      interactivity: { is_enabled: true },
      event_subscriptions: {
        bot_events: ["message.channels", "message.groups"],
      },
    },
  },
  null,
  2
);

export function SlackAppSection() {
  const client = useQueryClient();
  const [step, setStep] = useState(1);
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [validated, setValidated] = useState(false);
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["slack-app"],
    queryFn: () => api<State>(endpoint),
    refetchInterval: 10000,
  });
  const resetSetup = () => {
    setBotToken("");
    setAppToken("");
    setValidated(false);
    setChannels([]);
    setChannelId("");
    setWorkspace("");
    setMessage("");
  };
  const originOptions = query.data?.linkOrigins?.options ?? [];
  const allowedOrigin = (value: string | null | undefined) =>
    originOptions.some((option) => option.url === value);
  const selectedOrigin = allowedOrigin(baseUrl)
    ? baseUrl
    : allowedOrigin(query.data?.binding?.baseUrl)
      ? query.data!.binding!.baseUrl
      : (query.data?.linkOrigins?.defaultUrl ?? "");
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
        setWorkspace(result.teamName || "Your workspace");
        setStep(3);
        setMessage(`Validated ${result.teamName}. Choose a channel below.`);
      } else if (name === "recheck") {
        setMessage(
          result.missingAnswerScopes === null
            ? "Connection checked. Slack did not supply scope evidence; permissions remain unknown."
            : "Permissions rechecked. Current capabilities are shown below."
        );
      } else if (name === "refresh") {
        setChannels(result.channels);
        setChannelId((id) =>
          result.channels.some((channel) => channel.id === id) ? id : ""
        );
      } else {
        if (name !== "test") {
          resetSetup();
          setEditing(false);
          setStep(1);
        }
        setMessage(
          name === "test"
            ? "Test delivered to Slack. This does not mean it was read."
            : name === "disconnect"
              ? "Disconnected and cleared credentials."
              : "Slack notifications enabled."
        );
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
  const configured = !!query.data?.configured;
  // Not loaded is not "not set up".
  const showSetup = !!query.data && (!configured || editing);
  const status = query.isError
    ? "Unavailable"
    : query.data?.status
      ? statusLabel(query.data.status)
      : "Loading";
  const connected = query.data?.status === "connected";
  return (
    <SettingsGroup
      aria-label="Slack app setup"
      title="Slack notifications"
      description="A direct line from your agents to your workspace."
      actions={
        <Badge
          dot
          tone={
            connected
              ? "success"
              : query.data?.status === "credentials_rejected" || query.isError
                ? "danger"
                : "neutral"
          }
          role="status"
        >
          {status}
        </Badge>
      }
    >
      {query.isPending && (
        <LoadingSkeleton label="Loading Slack setup…" rowClassName="h-16" />
      )}
      {/* A missed poll shows on the badge alone. */}
      {query.isError && !query.data && (
        <LoadError
          thing="Slack setup"
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      )}
      {configured && (
        <Card>
          <CardHeader>
            <CardDescription>Notification destination</CardDescription>
            <CardTitle className="flex items-center gap-2">
              <Hash
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              {query.data?.binding?.channelName}
            </CardTitle>
            <p className="text-body-md text-muted-foreground">
              {query.data?.binding?.teamName}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button disabled={action.isPending} onClick={() => run("test")}>
                <Radio aria-hidden="true" />
                Send test
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => {
                  if (editing) {
                    resetSetup();
                    action.reset();
                  }
                  setEditing(!editing);
                  setStep(2);
                }}
              >
                {" "}
                {editing ? "Cancel replacement" : "Replace tokens"}
              </Button>
            </div>
            <p className="text-body-sm text-muted-foreground" role="status">
              Socket Mode WebSocket: {statusLabel(query.data?.status ?? "")}. A
              connected socket does not verify interactive callback delivery.
            </p>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => run("recheck")}
            >
              {action.isPending && action.variables?.name === "recheck"
                ? "Rechecking permissions…"
                : "Recheck permissions"}
            </Button>
            {query.data?.callbackDiagnostic && (
              <p className="text-body-sm text-muted-foreground">
                Last Socket Mode callback:{" "}
                {statusLabel(query.data.callbackDiagnostic.stage)} ·{" "}
                {new Date(
                  query.data.callbackDiagnostic.at
                ).toLocaleTimeString()}
                . If no new callback appears after your Slack click, check
                Socket Mode delivery. A failed handler needs a retry with a
                fresh link after diagnosis.
              </p>
            )}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  Connection details
                  <ChevronDown aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3 text-body-sm text-muted-foreground">
                <p className="break-all">
                  Dispatch link: {query.data?.binding?.baseUrl}
                </p>
                <p>
                  While this host is asleep or offline, messages cannot be
                  delivered. A connection or delivery receipt does not mean the
                  notification was read.
                </p>
                <Button
                  variant="ghost"
                  tone="danger"
                  size="sm"
                  disabled={action.isPending}
                  onClick={() => run("disconnect")}
                >
                  <Unplug aria-hidden="true" />
                  Disconnect and clear tokens
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      )}

      {configured && !editing && query.data?.binding && <SlackTimingCard />}

      {configured && !editing && query.data?.binding && (
        <SlackAnswerersCard
          channelName={query.data.binding.channelName}
          answerers={query.data.answerers ?? []}
          missingScopes={query.data.missingAnswerScopes ?? null}
          manifest={manifest}
          missingLinkScopes={query.data.missingLinkScopes ?? null}
          missingImageScopes={query.data.missingImageScopes ?? null}
        />
      )}

      {showSetup && (
        <>
          <ol
            aria-label="Slack setup progress"
            className="flex items-start gap-3 py-2"
          >
            {["Create app", "Connect tokens", "Choose channel"].map(
              (label, index) => (
                <li
                  key={label}
                  aria-current={step === index + 1 ? "step" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2"
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full text-body-sm",
                      step === index + 1
                        ? "bg-primary text-primary-foreground"
                        : step > index + 1
                          ? "bg-surface-selected text-primary"
                          : "bg-muted text-muted-foreground"
                    )}
                  >
                    {step > index + 1 ? (
                      <Check className="size-3" aria-label="Complete" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-body-sm sm:text-body-md",
                      step === index + 1
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {label}
                  </span>
                  {index < 2 && (
                    <span
                      className="hidden h-px flex-1 bg-border sm:block"
                      aria-hidden="true"
                    />
                  )}
                </li>
              )
            )}
          </ol>

          {step === 1 && (
            <Card>
              <CardHeader>
                <CardDescription>Step 1 of 3</CardDescription>
                <CardTitle>Your workspace. Your Slack app.</CardTitle>
                <CardDescription>
                  Create a private Dispatch app in Slack. We’ve prepared its
                  configuration for you.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Panel>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-body-md font-medium">
                        Copy the app manifest
                      </p>
                      <p className="mt-1 text-body-sm text-muted-foreground">
                        Includes Socket Mode, buttons and forms, and thread
                        replies under Dispatch’s own messages.
                      </p>
                    </div>
                    <CopyButton
                      text={manifest}
                      label="Copy manifest"
                      copiedLabel="Manifest copied"
                    />
                  </div>
                  <Disclosure label="Preview manifest">
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-background/veil p-3 text-label-sm">
                      {manifest}
                    </pre>
                  </Disclosure>
                </Panel>
                <div className="space-y-3">
                  <Button asChild variant="primary">
                    <a
                      href="https://api.slack.com/apps"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Slack app management
                      <ExternalLink
                        className="ml-2 size-3.5"
                        aria-hidden="true"
                      />
                    </a>
                  </Button>
                  <p className="text-body-md text-muted-foreground">
                    Choose{" "}
                    <strong className="font-medium text-foreground">
                      Create New App → From a manifest
                    </strong>
                    , select your workspace, then paste and create. Your
                    workspace may require admin approval.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <span className="text-body-sm text-muted-foreground">
                    Already have your own app? Continue here.
                  </span>
                  <Button variant="primary" onClick={() => setStep(2)}>
                    App created
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader>
                <CardDescription>Step 2 of 3</CardDescription>
                <CardTitle>Connect with two tokens</CardTitle>
                <CardDescription>
                  Copy these from your app’s Slack dashboard. No callback URL or
                  tunnel is needed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Panel className="space-y-3">
                  <Field
                    id="slack-app-token"
                    label={
                      <span className="flex items-center gap-2">
                        <KeyRound
                          className="size-icon-lg text-muted-foreground"
                          aria-hidden="true"
                        />
                        App token
                      </span>
                    }
                    labelAction={<Badge className="ml-auto">xapp</Badge>}
                  >
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
                  </Field>
                  <Disclosure label="Where do I find the app token?">
                    <p>
                      Basic Information → App-Level Tokens → Generate Token and
                      Scopes. Add the scope below, then generate and copy the
                      token.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-sm bg-surface-hover px-3 py-2">
                      <code>connections:write</code>
                      <CopyButton
                        text="connections:write"
                        label="Copy scope"
                        copiedLabel="Scope copied"
                      />
                    </div>
                  </Disclosure>
                </Panel>
                <Panel className="space-y-3">
                  <Field
                    id="slack-bot-token"
                    label={
                      <span className="flex items-center gap-2">
                        <KeyRound
                          className="size-icon-lg text-muted-foreground"
                          aria-hidden="true"
                        />
                        Bot token
                      </span>
                    }
                    labelAction={<Badge className="ml-auto">xoxb</Badge>}
                  >
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
                  </Field>
                  <Disclosure label="Where do I find the bot token?">
                    <p>
                      OAuth &amp; Permissions → Install to Workspace → Allow.
                      Slack handles installation in its own dashboard. Copy the
                      Bot User OAuth Token shown afterward.
                    </p>
                  </Disclosure>
                </Panel>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                  <Button
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => setStep(1)}
                  >
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    disabled={action.isPending || !botToken || !appToken}
                    onClick={() => run("validate", { botToken, appToken })}
                  >
                    {action.isPending ? "Validating…" : "Validate tokens"}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 3 && validated && (
            <Card>
              <CardHeader>
                <CardDescription>Step 3 of 3 · {workspace}</CardDescription>
                <CardTitle>Choose where alerts land</CardTitle>
                <CardDescription>
                  Add Dispatch to a Slack channel, then select it here.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    className="text-body-sm font-medium"
                    id="slack-channel-label"
                  >
                    Notification channel
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => run("refresh")}
                  >
                    Refresh channels
                  </Button>
                </div>
                <Select
                  disabled={action.isPending}
                  value={channelId}
                  onValueChange={setChannelId}
                >
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
                  <p className="text-body-sm text-muted-foreground">
                    No joined channels yet. Use the channel’s Add apps menu in
                    Slack to invite Dispatch, then refresh.
                  </p>
                )}
                <div className="space-y-2">
                  <label
                    className="text-body-sm font-medium"
                    id="slack-address-label"
                  >
                    Dispatch address
                  </label>
                  <Select
                    disabled={action.isPending || !originOptions.length}
                    value={selectedOrigin}
                    onValueChange={setBaseUrl}
                  >
                    <SelectTrigger aria-label="Dispatch address">
                      <SelectValue placeholder="No active server addresses" />
                    </SelectTrigger>
                    <SelectContent>
                      {originOptions.map((option) => (
                        <SelectItem key={option.url} value={option.url}>
                          {option.url}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-body-sm text-muted-foreground">
                    Used for links in Slack.
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                  <Button
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => setStep(2)}
                  >
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    disabled={action.isPending || !channelId || !selectedOrigin}
                    onClick={() =>
                      run("enable", { channelId, baseUrl: selectedOrigin })
                    }
                  >
                    {action.isPending ? "Connecting…" : "Enable notifications"}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {action.error && (
        <Alert title="Couldn’t complete this step." error={action.error} />
      )}
      {message && (
        <p
          className="flex items-start gap-2 text-body-md text-muted-foreground"
          role="status"
        >
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {message}
        </p>
      )}
    </SettingsGroup>
  );
}

function Disclosure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          wrap
          className="-ml-2 max-w-full justify-start text-left text-body-sm"
        >
          {label}
          <ChevronDown aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 text-body-sm leading-relaxed text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
