import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, ShieldCheck, UserCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";

export type SlackAnswerer = {
  id: string;
  userId: string;
  displayName: string;
  status: "pending" | "allowed";
  createdAt: string;
};

const endpoint = "/api/v1/notifications/slack-app";

/**
 * Who may answer Dispatch questions from Slack. Nobody by default; a
 * one-time link button in the channel creates a pending request that only
 * takes effect once the owner allows it here.
 */
export function SlackAnswerersCard({
  channelName,
  answerers,
  missingScopes,
  manifest,
  missingLinkScopes,
  missingImageScopes,
}: {
  channelName: string;
  answerers: SlackAnswerer[];
  missingScopes: string[] | null;
  manifest: string;
  missingLinkScopes: string[] | null;
  missingImageScopes: string[] | null;
}) {
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const action = useMutation({
    mutationFn: async (input: { name: string; id?: string }) => {
      await api(`${endpoint}/${input.name}`, {
        method: "POST",
        body: JSON.stringify(input.id ? { id: input.id } : {}),
      });
      await client.invalidateQueries({ queryKey: ["slack-app"] });
    },
    onSuccess: (_data, input) => {
      // Worded so it stays true after the link is used or expires.
      if (input.name === "link")
        setMessage(
          `Link posted in #${channelName} (one use, 10 min). New requests appear above.`
        );
    },
  });
  const run = (name: string, id?: string) => {
    setMessage("");
    action.mutate({ name, id });
  };
  const pending = answerers.filter((a) => a.status === "pending");
  const allowed = answerers.filter((a) => a.status === "allowed");
  const needsUpdate = !!missingScopes?.length;

  return (
    <Card className="border border-border" aria-label="Slack answerers">
      <CardHeader>
        <CardDescription>Answering from Slack</CardDescription>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          Who can answer
        </CardTitle>
        <CardDescription>
          Only people you allow can answer questions or message agents from
          Slack. Being in #{channelName} isn’t enough.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Post a link, click Link my account in Slack, then return here to Allow
          the pending identity. Settings checks for requests every 10 seconds.
          Socket Mode and Slack Interactivity must be enabled; Dispatch cannot
          probe the Interactivity setting.
        </p>
        {missingScopes === null && (
          <p className="text-xs text-muted-foreground">
            Slack has not supplied permission evidence. Recheck permissions;
            unknown grants are not verified.
          </p>
        )}
        {!!missingLinkScopes?.length && (
          <p className="text-sm text-destructive">
            Account linking needs: {missingLinkScopes.join(", ")}. Update the
            manifest, reinstall, then recheck permissions.
          </p>
        )}
        {!!missingImageScopes?.length && (
          <p className="text-xs text-muted-foreground">
            Optional images unavailable: {missingImageScopes.join(", ")}.
            Account linking uses separate permissions.
          </p>
        )}

        {needsUpdate && (
          <div
            className="space-y-2 rounded-lg border border-border bg-muted/25 p-4"
            data-testid="slack-manifest-update"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">Update your Slack app first</p>
              <CopyButton
                text={manifest}
                label="Copy manifest"
                copiedLabel="Manifest copied"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              In Slack app management open App Manifest, paste, save, then
              Reinstall to Workspace, then return here and recheck permissions.
              Missing thread reply permissions: {missingScopes!.join(", ")}.
            </p>
          </div>
        )}

        {pending.length > 0 && (
          <ul className="space-y-2" aria-label="Pending link requests">
            {pending.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {a.displayName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Slack ID <span className="font-mono">{a.userId}</span> ·
                    match it to their Slack profile before allowing
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => run("revoke", a.id)}
                  >
                    Decline
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => run("allow", a.id)}
                  >
                    <UserCheck className="mr-2 size-3.5" aria-hidden="true" />
                    Allow
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {allowed.length > 0 ? (
          <ul className="divide-y divide-border" aria-label="Allowed answerers">
            {allowed.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {a.displayName}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {a.userId}
                  </span>
                </span>
                <Badge variant="running">Allowed</Badge>
                <Button
                  variant="ghost-destructive"
                  size="sm"
                  aria-label={`Remove ${a.displayName}`}
                  disabled={action.isPending}
                  onClick={() => run("revoke", a.id)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          pending.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No one yet. Questions show an Open in Dispatch link only.
            </p>
          )
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            Posts a one-time button in #{channelName}; whoever clicks shows up
            here.
          </span>
          <Button
            disabled={action.isPending || !!missingLinkScopes?.length}
            onClick={() => run("link")}
          >
            <Link2 className="mr-2 size-3.5" aria-hidden="true" />
            Link a Slack account
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Their answers count the same as yours in Dispatch, including
          approvals.
        </p>
        {action.error && (
          <p role="alert" className="text-sm text-destructive">
            {action.error.message}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
