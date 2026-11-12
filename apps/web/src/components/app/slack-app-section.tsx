import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Hash,
  KeyRound,
  LockKeyhole,
  Radio,
  ShieldCheck,
  Slack,
  Unplug,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
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
  const [step, setStep] = useState(1);
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState("");
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
  const resetSetup = () => {
    setBotToken("");
    setAppToken("");
    setValidated(false);
    setChannels([]);
    setChannelId("");
    setWorkspace("");
    setMessage("");
  };
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
  const showSetup = !configured || editing;
  const status = query.isError
    ? "Unavailable"
    : query.data?.status.replaceAll("_", " ") || "Loading";
  const connected = query.data?.status === "connected";
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  return (
    <section
      className="border-t border-border pt-8 space-y-5"
      aria-label="Slack app setup"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-border bg-muted/50 p-2.5">
            <Slack className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Slack notifications</h3>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              A direct line from your agents to your workspace.
            </p>
          </div>
        </div>
        <Badge
          variant={
            connected
              ? "running"
              : query.data?.status === "credentials_rejected" || query.isError
                ? "error"
                : "default"
          }
          className="gap-1.5"
          role="status"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-status-working" : "bg-current"
            )}
          />
          {status}
        </Badge>
      </div>

      {configured && (
        <Card className="border border-status-working/20">
          <CardHeader>
            <CardDescription>Notification destination</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hash
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              {query.data?.binding?.channelName}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {query.data?.binding?.teamName}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button disabled={action.isPending} onClick={() => run("test")}>
                <Radio className="mr-2 size-3.5" aria-hidden="true" />
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
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="px-0">
                  Connection details
                  <ChevronDown className="ml-2 size-3.5" aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3 text-xs text-muted-foreground">
                <p className="break-all">
                  Dispatch link: {query.data?.binding?.baseUrl}
                </p>
                <p>
                  While this host is asleep or offline, messages cannot be
                  delivered. A connection or delivery receipt does not mean the
                  notification was read.
                </p>
                <Button
                  variant="ghost-destructive"
                  size="sm"
                  disabled={action.isPending}
                  onClick={() => run("disconnect")}
                >
                  <Unplug className="mr-2 size-3.5" aria-hidden="true" />
                  Disconnect and clear tokens
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      )}

      {showSetup && (
        <>
          <nav
            aria-label="Slack setup progress"
            className="grid grid-cols-3 gap-2"
          >
            {["Create app", "Connect tokens", "Choose channel"].map(
              (label, index) => (
                <button
                  key={label}
                  type="button"
                  disabled={action.isPending || (index === 2 && !validated)}
                  onClick={() => setStep(index + 1)}
                  aria-current={step === index + 1 ? "step" : undefined}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors disabled:opacity-40 sm:text-sm",
                    step === index + 1
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                      step === index + 1
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    )}
                  >
                    {validated && index < 2 ? (
                      <Check className="size-3" aria-label="Complete" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span>{label}</span>
                </button>
              )
            )}
          </nav>

          {step === 1 && (
            <Card className="border border-border">
              <CardHeader>
                <CardDescription>Step 1 of 3</CardDescription>
                <CardTitle className="text-base">
                  Your workspace. Your Slack app.
                </CardTitle>
                <CardDescription>
                  Create a private Dispatch app in Slack. We’ve prepared its
                  configuration for you.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="rounded-lg border border-border bg-muted/25 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        Copy the app manifest
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Includes Socket Mode and the required permissions.
                      </p>
                    </div>
                    <CopyControl text={manifest} label="Copy manifest" />
                  </div>
                  <Disclosure label="Preview manifest">
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/50 p-3 text-[11px]">
                      {manifest}
                    </pre>
                  </Disclosure>
                </div>
                <div className="space-y-3">
                  <Button asChild>
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
                  <p className="text-sm text-muted-foreground">
                    Choose{" "}
                    <strong className="font-medium text-foreground">
                      Create New App → From a manifest
                    </strong>
                    , select your workspace, then paste and create. Your
                    workspace may require admin approval.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <span className="text-xs text-muted-foreground">
                    Already have your own app? Continue here.
                  </span>
                  <Button variant="primary" onClick={() => setStep(2)}>
                    App created
                    <ArrowRight className="ml-2 size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card className="border border-border">
              <CardHeader>
                <CardDescription>Step 2 of 3</CardDescription>
                <CardTitle className="text-base">
                  Connect with two tokens
                </CardTitle>
                <CardDescription>
                  Copy these from your app’s Slack dashboard. No callback URL or
                  tunnel is needed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <KeyRound
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <label
                      htmlFor="slack-app-token"
                      className="text-sm font-medium"
                    >
                      App token
                    </label>
                    <Badge className="ml-auto normal-case">xapp</Badge>
                  </div>
                  <Input
                    id="slack-app-token"
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
                  <Disclosure label="Where do I find the app token?">
                    <p>
                      Basic Information → App-Level Tokens → Generate Token and
                      Scopes. Add the scope below, then generate and copy the
                      token.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded bg-muted/50 px-3 py-2">
                      <code>connections:write</code>
                      <CopyControl
                        text="connections:write"
                        label="Copy scope"
                      />
                    </div>
                  </Disclosure>
                </div>
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <KeyRound
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <label
                      htmlFor="slack-bot-token"
                      className="text-sm font-medium"
                    >
                      Bot token
                    </label>
                    <Badge className="ml-auto normal-case">xoxb</Badge>
                  </div>
                  <Input
                    id="slack-bot-token"
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
                  <Disclosure label="Where do I find the bot token?">
                    <p>
                      OAuth &amp; Permissions → Install to Workspace → Allow.
                      Slack handles installation in its own dashboard. Copy the
                      Bot User OAuth Token shown afterward.
                    </p>
                  </Disclosure>
                </div>
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
                    <ArrowRight className="ml-2 size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 3 && validated && (
            <Card className="border border-border">
              <CardHeader>
                <CardDescription>Step 3 of 3 · {workspace}</CardDescription>
                <CardTitle className="text-base">
                  Choose where alerts land
                </CardTitle>
                <CardDescription>
                  Add Dispatch to a Slack channel, then select it here.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    className="text-sm font-medium"
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
                  <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                    No joined channels yet. Use the channel’s Add apps menu in
                    Slack to invite Dispatch, then refresh.
                  </p>
                )}
                <div className="flex gap-2 rounded-lg border border-status-waiting/25 bg-status-waiting/5 p-3 text-xs text-muted-foreground">
                  <LockKeyhole
                    className="mt-0.5 size-4 shrink-0 text-status-waiting"
                    aria-hidden="true"
                  />
                  <p>
                    {selectedChannel ? (
                      <>
                        Everyone in{" "}
                        <strong className="text-foreground">
                          #{selectedChannel.name}
                        </strong>
                      </>
                    ) : (
                      "Everyone in the selected channel"
                    )}{" "}
                    can read notification text and question context. Channel
                    membership grants no answer or approval authority.
                  </p>
                </div>
                <label className="block space-y-2 text-sm font-medium">
                  Dispatch web URL
                  <Input
                    aria-label="Dispatch web URL"
                    disabled={action.isPending}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Links in Slack use this address. Choose one you can reach on
                  your LAN or VPN.
                </p>
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
                    disabled={action.isPending || !channelId || !baseUrl}
                    onClick={() => run("enable", { channelId, baseUrl })}
                  >
                    {action.isPending ? "Connecting…" : "Enable notifications"}
                    <ArrowRight className="ml-2 size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-xs font-medium">
              <ShieldCheck
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              Before you connect
            </div>
            <div className="mt-3 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
              <p>
                <span className="block font-medium text-foreground">
                  Stored on your instance
                </span>
                Tokens stay in your Dispatch database, not encrypted at rest.
                Protect the host and backups.
              </p>
              <p>
                <span className="block font-medium text-foreground">
                  Outbound connection only
                </span>
                No public Dispatch URL. This host must be awake and online to
                deliver alerts.
              </p>
            </div>
            <Disclosure label="Permissions and connection details">
              <p>
                The app can post messages and list accessible channel metadata.
                It does not request message history or the user directory.
                Tokens are masked and never returned by Settings; use trusted
                HTTPS to configure a remote instance.
              </p>
              <p className="mt-2">
                No client secret, signing secret, callback URL, or separate
                Slack process is needed. Receiving a notification does not mean
                it was read or that an agent picked up work.
              </p>
            </Disclosure>
          </div>
        </>
      )}

      {action.error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <p className="font-medium">Couldn’t complete this step</p>
          <p className="mt-1 text-xs">{action.error.message}</p>
        </div>
      )}
      {message && (
        <p
          className="flex items-start gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <span>Notify tool: immediate alerts</span>
        <span>Unanswered questions: once after 5 minutes</span>
        <span>No repeating reminders</span>
      </div>
    </section>
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
          className="h-auto max-w-full whitespace-normal px-0 py-2 text-left text-xs"
        >
          {label}
          <ChevronDown className="ml-2 size-3 shrink-0" aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 text-xs leading-relaxed text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CopyControl({ text, label }: { text: string; label: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "error">("idle");
  return (
    <div>
      <Button
        size="sm"
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(text))
            .then(
              () => setResult("copied"),
              () => setResult("error")
            );
        }}
      >
        {result === "copied" ? (
          <Check className="mr-2 size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="mr-2 size-3.5" aria-hidden="true" />
        )}
        {result === "copied" ? "Copied" : label}
      </Button>
      {result === "error" && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Copy unavailable. Expand the details to select the text.
        </p>
      )}
    </div>
  );
}
