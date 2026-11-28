import {
  githubCliMissing,
  isGitHubAccountIssue,
  githubDeviceUrl,
  type GitHubStatus,
} from "@dispatch/runner-protocol";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Github } from "lucide-react";

import { Button, LoadingButton } from "@/components/ui/button";
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
  if (
    (runner.kind !== "local" && runner.status !== "online") ||
    !runner.githubManagement
  ) {
    return (
      <div className="space-y-1" data-testid="runner-github">
        <AccountHeading />
        <p className="text-body-md text-muted-foreground">
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
    <h4 className="flex items-center gap-2 text-body-md font-medium">
      <Github className="size-4" aria-hidden="true" /> GitHub
    </h4>
  );
}

function accountSummary(account: GitHubStatus) {
  switch (account.status) {
    case "signed-in":
      return `Signed in as @${account.login}`;
    case "signed-out":
      return "Connect GitHub to use private repositories.";
    case "pending":
      return account.code
        ? "Waiting for GitHub approval"
        : "Requesting a device code…";
    case "failed":
      return account.message ?? "Sign-in did not complete. Try again.";
    case "unavailable":
      return isGitHubAccountIssue(account.message)
        ? account.message
        : "Connect GitHub to use private repositories.";
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
    mutationFn: async (op: "login" | "logout" | "cancel") => {
      const result = await api<GitHubStatus>(
        op === "logout" ? path : path + "/login",
        {
          method: op === "login" ? "POST" : "DELETE",
        }
      );
      if (result.status === "unavailable" || result.status === "failed") {
        throw new Error(
          result.message ?? "Couldn’t complete the GitHub request."
        );
      }
      return result;
    },
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
  const missingCli =
    state?.status === "unavailable" && state.message === githubCliMissing;
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
            className="break-words text-body-sm text-muted-foreground"
          >
            {statusText}
          </p>
        </div>
        {account.isError || missingCli ? (
          <LoadingButton
            type="button"
            size="sm"
            loading={account.isFetching}
            onClick={() => void account.refetch()}
          >
            Retry
          </LoadingButton>
        ) : signedIn ? (
          <LoadingButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            loading={action.isPending && action.variables === "logout"}
            onClick={() => setConfirmLogout(true)}
          >
            Sign out
          </LoadingButton>
        ) : pending ? (
          <LoadingButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            loading={action.isPending && action.variables === "cancel"}
            onClick={() => action.mutate("cancel")}
          >
            Cancel sign-in
          </LoadingButton>
        ) : (
          !account.isPending && (
            <LoadingButton
              type="button"
              size="sm"
              disabled={action.isPending}
              aria-label="Sign in to GitHub"
              loading={action.isPending && action.variables === "login"}
              onClick={() => action.mutate("login")}
            >
              {action.isPending ? "Starting…" : "Sign in"}
            </LoadingButton>
          )
        )}
      </div>
      {pending && state.code && !account.isError && (
        <div className="space-y-2 rounded-md border border-border bg-background/veil p-3">
          <p className="text-body-md">
            Enter this code on GitHub. Agents on {runner.name} will use the
            account you approve.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <code className="select-all text-body-lg font-semibold tracking-wider">
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
      {signedIn && state.gitIdentityUnavailable && (
        <p role="alert" className="text-body-md text-danger">
          Git could not configure the author identity. Set user.name and
          user.email in the runner workload account’s Git config.
        </p>
      )}
      {action.isError && (
        <p role="alert" className="text-body-md text-danger">
          {action.error.message}
        </p>
      )}
      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent>
          <AlertDialogTitle className="font-semibold">
            Sign out of GitHub on {runner.name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-body-md text-muted-foreground">
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
