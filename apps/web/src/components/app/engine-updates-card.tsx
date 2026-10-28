import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
import type { EngineStatus } from "@/hooks/use-engines";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type UpdateResult = { success: boolean; output: string; engine?: EngineStatus };
function Command({ command }: { command: string }): JSX.Element {
  const [copied, copyText] = useCopyText();
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded bg-muted p-2 text-xs">
        {command}
      </code>
      <Button size="sm" variant="default" onClick={() => copyText(command)}>
        {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  );
}
function EngineRow({
  engine,
  canManage,
}: {
  engine: EngineStatus;
  canManage: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: () =>
      api<UpdateResult>(`/api/v1/system/engines/${engine.id}/update`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["system-engines"] });
    },
  });
  const metadata = engine.update;
  return (
    <section className="space-y-2 border-t pt-4" aria-label={engine.label}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          {engine.label}{" "}
          <span className="text-sm text-muted-foreground">
            {engine.installed
              ? (engine.version ?? "Version unknown")
              : "Not installed"}
          </span>
        </h3>
        {engine.installed && canManage && metadata?.canUpdate && (
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate()}
          >
            {update.isPending ? "Updating…" : `Update ${engine.label}`}
          </Button>
        )}
      </div>
      {engine.path && (
        <p className="break-all font-mono text-sm">{engine.path}</p>
      )}
      {metadata?.realPath && metadata.realPath !== engine.path && (
        <p className="break-all text-xs text-muted-foreground">
          Real path: {metadata.realPath}
        </p>
      )}
      {metadata?.available && (
        <Badge variant="transitional">
          Update available: {engine.version} → {metadata.latestVersion}
        </Badge>
      )}
      <p className="text-sm text-muted-foreground">
        Source: {metadata?.source ?? "unknown"} ·{" "}
        {metadata?.latestPending
          ? "Checking latest…"
          : metadata?.latestVersion
            ? `Latest: ${metadata.latestVersion}${metadata.available ? " · Update available" : ""}`
            : "Latest version unknown"}
      </p>
      <p className="text-xs text-muted-foreground">
        {metadata?.reason ?? "Update manually using your installer."}
      </p>
      <Command command={metadata?.command ?? engine.install} />
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {update.error.message}
        </p>
      )}
      {update.data && (
        <div role="status" className="space-y-2 text-sm">
          <p>
            {update.data.success ? "Update completed" : "Update failed"}
            {update.data.engine?.version
              ? ` · Installed: ${update.data.engine.version}`
              : ""}
          </p>
          {update.data.output && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
              {update.data.output}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
export function EngineUpdatesCard(): JSX.Element {
  const query = useQuery<{ engines: EngineStatus[]; canManage?: boolean }>({
    queryKey: ["system-engines"],
    queryFn: () => api("/api/v1/system/engines"),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.engines.some((engine) => engine.update?.latestPending)
        ? 2_000
        : false,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Engines</CardTitle>
        <CardDescription>
          Updates apply to new launches and restarts. Existing agents keep their
          current binary.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && <p>Checking engine installations…</p>}
        {query.isError && (
          <div role="alert">
            <p>Unable to check engines: {query.error.message}</p>
            <Button size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {query.data?.engines.map((engine) => (
          <EngineRow
            key={engine.id}
            engine={engine}
            canManage={query.data?.canManage === true}
          />
        ))}
      </CardContent>
    </Card>
  );
}
