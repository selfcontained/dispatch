import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy";
import { Button } from "@/components/ui/button";
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

type PairRequest = { id: string; hostname: string; expiresAt: string };

function ApproveRunner({ request }: { request: PairRequest }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(request.hostname);
  const [code, setCode] = useState("");
  const approve = useMutation({
    mutationFn: () =>
      api(
        "/api/v1/runners/pairing-requests/" +
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
  return (
    <form
      className="space-y-2 rounded-md border border-primary/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && code.trim() && !approve.isPending) approve.mutate();
      }}
      data-testid="runner-approval"
    >
      <p className="text-sm font-medium">Approve {request.hostname}</p>
      <p className="text-xs text-muted-foreground">
        Enter the code printed on that machine to grant it access.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Runner name
          <Input
            value={name}
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
      <Button
        type="submit"
        variant="primary"
        disabled={!name.trim() || !code.trim() || approve.isPending}
      >
        Approve runner
      </Button>
      {approve.error && (
        <p className="text-sm text-destructive" role="alert">
          {approve.error.message}
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

export function RunnerOnboarding() {
  const [opened, setOpened] = useState(false);
  const pending = useQuery({
    queryKey: ["runner-pairing-requests"],
    queryFn: () =>
      api<{ requests: PairRequest[] }>("/api/v1/runners/pairing-requests"),
    refetchInterval: 5000,
    retry: false,
  });
  const instructions = useQuery({
    queryKey: ["runner-connect-instructions"],
    queryFn: () => api<{ command: string }>("/api/v1/runners/connect-command"),
    enabled: opened,
    retry: false,
  });
  const installer = useRunnerInstaller(opened);
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant={opened ? "ghost" : "primary"}
        onClick={() => setOpened((v) => !v)}
        aria-expanded={opened}
      >
        {opened ? "Hide setup instructions" : "Add runner"}
      </Button>
      {opened && (
        <div className="space-y-4 rounded-md border p-3">
          <section className="space-y-1">
            <h4 className="text-sm font-medium">Install on Linux</h4>
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
              <p role="status">Checking release…</p>
            ) : installer.data?.command ? (
              <RunnerCommand value={installer.data.command} label="Install" />
            ) : (
              <p className="text-xs text-muted-foreground">
                A signed runner installer is not available for this release. If
                the runner is already installed, continue below.
              </p>
            )}
          </section>
          <section className="space-y-1">
            <h4 className="text-sm font-medium">Connect to Dispatch</h4>
            <p className="text-xs text-muted-foreground">
              Run this on the machine. It will print a pairing code to enter
              here.
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
              <p role="status">Preparing command…</p>
            )}
          </section>
        </div>
      )}
      {pending.data?.requests.map((request) => (
        <ApproveRunner key={request.id} request={request} />
      ))}
      {pending.isError && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => void pending.refetch()}
        >
          Retry loading approval requests
        </Button>
      )}
    </div>
  );
}
