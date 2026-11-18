import { useState, type FormEvent } from "react";
import { Copy, Server, Unplug } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCopyText } from "@/hooks/use-copy";
import {
  useRunnerMutations,
  useRunners,
  type RunnerPairing,
  type RunnerStatus,
} from "@/hooks/use-runners";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<RunnerStatus, string> = {
  pending: "Waiting to pair",
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

const STATUS_DOT: Record<RunnerStatus, string> = {
  pending: "bg-amber-400",
  online: "bg-emerald-500",
  offline: "bg-muted-foreground/60",
  revoked: "bg-destructive",
};

export function RunnerSettings(): JSX.Element {
  const runners = useRunners({ poll: true });
  const { pair, revoke } = useRunnerMutations();
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<RunnerPairing | null>(null);
  const [copied, copyText] = useCopyText();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pair.isPending) return;
    pair.mutate(trimmed, {
      onSuccess: (result) => {
        setPairing(result);
        setName("");
      },
    });
  };

  const list = runners.data ?? [];

  return (
    <Card data-testid="runner-settings">
      <CardHeader>
        <CardTitle className="text-base">Remote runners</CardTitle>
        <CardDescription>
          Run agents on another machine. Pair a runner, then pick it in Create
          Agent. Local agents keep working if a runner disconnects.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={submit}
          className="flex flex-col gap-2 sm:flex-row"
          data-testid="runner-pair-form"
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Runner name, e.g. lima"
            aria-label="Runner name"
            data-testid="runner-name-input"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || pair.isPending}
            data-testid="runner-pair-submit"
          >
            Pair runner
          </Button>
        </form>
        {pair.isError && (
          <p className="text-sm text-destructive" role="alert">
            {pair.error instanceof Error
              ? pair.error.message
              : "Could not start pairing."}
          </p>
        )}

        {pairing && (
          <div
            className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3"
            data-testid="runner-pairing"
          >
            <p className="text-sm">
              Run this on the runner machine. It expires{" "}
              {formatDateTime(pairing.expiresAt)}.
            </p>
            <pre
              className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-xs"
              data-testid="runner-command"
            >
              {pairing.command}
            </pre>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="gap-1.5 border border-border"
                onClick={() => copyText(pairing.command)}
                data-testid="runner-command-copy"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPairing(null)}
              >
                Done
              </Button>
            </div>
          </div>
        )}

        {runners.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading runners...
          </p>
        ) : runners.isError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              Could not load runners.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="border border-border"
              onClick={() => void runners.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No runners yet. Agents run on this Mac.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="runner-list">
            {list.map((runner) => (
              <li
                key={runner.id}
                className="flex flex-col gap-2 rounded-md border border-border bg-background/50 px-3 py-3 sm:flex-row sm:items-center"
                data-testid={`runner-${runner.id}`}
                data-status={runner.status}
              >
                <Server
                  className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {runner.name}
                    </p>
                    <Badge
                      variant="default"
                      className="gap-1.5 normal-case tracking-normal"
                      data-testid={`runner-status-${runner.id}`}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          STATUS_DOT[runner.status]
                        )}
                        aria-hidden="true"
                      />
                      {STATUS_LABEL[runner.status]}
                    </Badge>
                  </div>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {runner.workspaces.length > 0
                      ? `Workspaces: ${runner.workspaces.join(", ")}`
                      : "No workspaces reported"}
                  </p>
                </div>
                {runner.status !== "revoked" &&
                  (confirmId === runner.id ? (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={revoke.isPending}
                        aria-label={`Confirm revoke ${runner.name}`}
                        onClick={() =>
                          revoke.mutate(runner.id, {
                            onSettled: () => setConfirmId(null),
                          })
                        }
                        data-testid={`runner-revoke-confirm-${runner.id}`}
                      >
                        Revoke access
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1.5 self-start text-destructive hover:text-destructive sm:self-center"
                      aria-label={`Revoke ${runner.name}`}
                      onClick={() => setConfirmId(runner.id)}
                      data-testid={`runner-revoke-${runner.id}`}
                    >
                      <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
                      Revoke
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && (
          <p className="text-sm text-destructive" role="alert">
            Could not revoke that runner. Try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
