import { githubDeviceUrl, type GitHubStatus } from "@dispatch/runner-protocol";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Github } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Runner } from "@/hooks/use-runners";
import { api } from "@/lib/api";

export function RunnerGitHubAccount({ runner }: { runner: Runner }) {
  if (runner.status === "revoked") return null;
  if (runner.status !== "online" || !runner.githubManagement) {
    return (
      <div className="space-y-1" data-testid="runner-github">
        <AccountHeading />
        <p className="text-sm text-muted-foreground">
          {runner.status === "online"
            ? "Update the runner to manage its GitHub account here."
            : "GitHub account details are available when the runner is online."}
        </p>
      </div>
    );
  }
  return <ConnectedAccount key={runner.id} runner={runner} />;
}

function AccountHeading() {
  return (
    <h4 className="flex items-center gap-2 text-sm font-medium">
      <Github className="size-4" aria-hidden="true" /> GitHub
    </h4>
  );
}

function accountSummary(account: GitHubStatus) {
  switch (account.status) {
    case "signed-in":
      return `Signed in as @${account.login}`;
    case "signed-out":
      return "Signed out · optional for GitHub access";
    case "pending":
      return account.code
        ? "Waiting for GitHub approval"
        : "Requesting a device code…";
    case "failed":
      return "Sign-in did not complete. Try again.";
    case "unavailable":
      return (
        account.message ??
        "Couldn’t verify the GitHub account from this runner. Check its connection and retry."
      );
  }
}

function ConnectedAccount({ runner }: { runner: Runner }) {
  const client = useQueryClient();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const path = "/api/v1/runners/" + encodeURIComponent(runner.id) + "/github";
  const key = ["runner-github-account", runner.id] as const;
  const account = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<GitHubStatus>(path, { signal, cache: "no-store" }),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
    retry: false,
    gcTime: 0,
  });
  const action = useMutation({
    gcTime: 0,
    mutationFn: (op: "login" | "logout" | "cancel") =>
      api<GitHubStatus>(op === "logout" ? path : path + "/login", {
        method: op === "login" ? "POST" : "DELETE",
      }),
    onMutate: () => client.cancelQueries({ queryKey: key }),
    onSuccess: async (value) => {
      client.setQueryData(key, value);
      client.removeQueries({
        queryKey: ["runner-repository-search", runner.id],
      });
      await client.invalidateQueries({ queryKey: key });
    },
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
  const state = account.data;
  const pending = state?.status === "pending";
  const signedIn = state?.status === "signed-in";
  const unavailable = state?.status === "unavailable";
  const statusText = account.isError
    ? "Couldn’t read the account."
    : state
      ? accountSummary(state)
      : "Checking account…";
  return (
    <div className="space-y-3" data-testid="runner-github">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <AccountHeading />
          <p
            role="status"
            className="break-words text-xs text-muted-foreground"
          >
            {statusText}
          </p>
        </div>
        {account.isError || unavailable ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void account.refetch()}
          >
            Retry
          </Button>
        ) : signedIn ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => setConfirmLogout(true)}
          >
            Sign out
          </Button>
        ) : pending ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => action.mutate("cancel")}
          >
            Cancel sign-in
          </Button>
        ) : (
          !account.isPending && (
            <Button
              type="button"
              size="sm"
              disabled={action.isPending}
              aria-label="Sign in to GitHub"
              onClick={() => action.mutate("login")}
            >
              {action.isPending ? "Starting…" : "Sign in"}
            </Button>
          )
        )}
      </div>
      {pending && state.code && !account.isError && (
        <div className="space-y-2 rounded-md border border-border bg-background/50 p-3">
          <p className="text-sm">
            Enter this code on GitHub. Agents on {runner.name} will use the
            account you approve.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <code className="select-all text-base font-semibold tracking-wider">
                {state.code}
              </code>
              <CopyButton text={state.code} label="Copy GitHub device code" />
            </div>
            <Button asChild size="sm" variant="primary">
              <a href={githubDeviceUrl} target="_blank" rel="noreferrer">
                Open GitHub{" "}
                <ExternalLink className="ml-1.5 size-3.5" aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {action.error.message}
        </p>
      )}
      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent>
          <AlertDialogTitle className="font-semibold">
            Sign out of GitHub on {runner.name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted-foreground">
            Agents on this runner will lose access through{" "}
            {signedIn ? `@${state.login}` : "this account"}. This removes the
            saved login from this machine. You can revoke the token separately
            on GitHub.
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => action.mutate("logout")}>
              Sign out
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
