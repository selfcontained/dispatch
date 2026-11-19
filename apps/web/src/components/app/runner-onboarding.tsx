import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { runnersQueryKey } from "@/hooks/use-runners";

export function RunnerCommand({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, copy] = useCopyText();
  return (
    <div className="space-y-1.5">
      <pre
        className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/70 p-2 text-xs"
        data-testid={label === "Connect" ? "runner-connect-command" : undefined}
      >
        {value}
      </pre>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="gap-1.5 border border-border"
        onClick={() => copy(value)}
        aria-label={`Copy ${label.toLowerCase()} command`}
      >
        <Copy size={14} />
        {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  );
}

type PairRequest = { id: string; createdAt: string; expiresAt: string };

function ApproveRunner({ request }: { request: PairRequest }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const approve = useMutation({
    mutationFn: () =>
      api(
        "/api/v1/runners/connect/" +
          encodeURIComponent(request.id) +
          "/approve",
        {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), code: code.trim() }),
        }
      ),
    onSuccess: async () => {
      setCode("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runnersQueryKey }),
        queryClient.invalidateQueries({
          queryKey: ["runner-pairing-requests"],
        }),
      ]);
    },
  });
  const dismiss = useMutation({
    mutationFn: () =>
      api("/api/v1/runners/connect/" + encodeURIComponent(request.id), {
        method: "DELETE",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["runner-pairing-requests"] }),
  });
  return (
    <form
      className="space-y-2 px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          name.trim() &&
          code.trim() &&
          !approve.isPending &&
          !dismiss.isPending
        )
          approve.mutate();
      }}
      data-testid="runner-approval"
    >
      <p className="text-sm font-medium">
        Connection request · {request.id.slice(-8)}
      </p>
      <p className="text-xs text-muted-foreground">
        Match the request reference and enter the code printed on the runner.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Runner name
          <Input
            value={name}
            placeholder="e.g. Build machine"
            maxLength={64}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Pairing code
          <Input
            value={code}
            required
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="submit"
          variant="primary"
          disabled={
            !name.trim() ||
            !code.trim() ||
            approve.isPending ||
            dismiss.isPending
          }
        >
          {approve.isPending ? "Approving…" : "Approve runner"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={approve.isPending || dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          {dismiss.isPending ? "Denying…" : "Deny request"}
        </Button>
      </div>
      {(approve.error || dismiss.error) && (
        <p className="text-sm text-destructive" role="alert">
          {(approve.error ?? dismiss.error)?.message}
        </p>
      )}
    </form>
  );
}

export function useRunnerInstaller(enabled: boolean) {
  return useQuery({
    queryKey: ["runner-installer-release"],
    queryFn: () =>
      api<{ command: string | null; tag: string | null }>(
        "/api/v1/runners/installer"
      ),
    enabled,
    staleTime: 300_000,
    retry: false,
  });
}

export function RunnerPairingRequests() {
  const pending = useQuery({
    queryKey: ["runner-pairing-requests"],
    queryFn: () => api<{ requests: PairRequest[] }>("/api/v1/runners/connect"),
    refetchInterval: 5000,
    retry: false,
  });
  if (pending.isError && !pending.data) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-destructive">
          Could not load pairing requests.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void pending.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  const requests = pending.data?.requests ?? [];
  if (requests.length === 0) return null;
  return (
    <section aria-labelledby="runner-pairing-heading" className="space-y-2">
      <h3 id="runner-pairing-heading" className="text-sm font-medium">
        Pending approvals
      </h3>
      <div className="divide-y divide-border rounded-md bg-muted/40">
        {requests.map((request) => (
          <ApproveRunner key={request.id} request={request} />
        ))}
      </div>
    </section>
  );
}

export function RunnerOnboarding() {
  const [opened, setOpened] = useState(false);
  const instructions = useQuery({
    queryKey: ["runner-connect-instructions"],
    queryFn: () => api<{ command: string }>("/api/v1/runners/connect-command"),
    enabled: opened,
    retry: false,
  });
  const installer = useRunnerInstaller(opened);
  return (
    <Dialog open={opened} onOpenChange={setOpened}>
      <DialogTrigger asChild>
        <Button type="button" variant="primary" className="shrink-0 gap-1.5">
          <Plus className="size-4" aria-hidden="true" />
          Add runner
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add runner</DialogTitle>
          <DialogDescription>
            Pair a Linux machine with this Dispatch instance.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto p-0.5">
          <section className="space-y-2">
            <h4 className="text-sm font-medium">1. Install on Linux</h4>
            <p className="text-xs text-muted-foreground">
              Use a Linux x86-64 or ARM64 machine with systemd, GitHub CLI, Git,
              and sudo access.
            </p>
            {installer.isError ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void installer.refetch()}
              >
                Retry release check
              </Button>
            ) : installer.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Checking release…
              </p>
            ) : installer.data?.command ? (
              <RunnerCommand value={installer.data.command} label="Install" />
            ) : (
              <p className="text-xs text-muted-foreground">
                A signed runner installer is not available for this release. If
                the runner is already installed, continue below.
              </p>
            )}
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">2. Connect to Dispatch</h4>
            <p className="text-xs text-muted-foreground">
              Run this on the machine, then close this dialog and approve the
              request using the pairing code printed in your terminal.
            </p>
            {instructions.data ? (
              <RunnerCommand
                value={instructions.data.command}
                label="Connect"
              />
            ) : instructions.isError ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void instructions.refetch()}
              >
                Retry connection instructions
              </Button>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Preparing command…
              </p>
            )}
          </section>
        </div>
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Done
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
