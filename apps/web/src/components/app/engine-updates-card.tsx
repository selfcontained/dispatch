import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Markdown } from "@/components/ui/markdown";
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
function InstallationDetails({
  engine,
}: {
  engine: EngineStatus;
}): JSX.Element {
  const source = engine.update?.source;
  const installer =
    source === "native"
      ? "Claude installer"
      : source === "npm"
        ? "npm"
        : source?.startsWith("homebrew-")
          ? "Homebrew"
          : null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight
          className="h-3 w-3 group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        Installation details
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2 text-xs text-muted-foreground">
        <p>
          {installer ? `Installed using ${installer}` : "Installer unknown"}
        </p>
        {engine.path && <p className="break-all font-mono">{engine.path}</p>}
        {engine.update?.realPath && engine.update.realPath !== engine.path && (
          <p className="break-all">Resolved path: {engine.update.realPath}</p>
        )}
        {engine.update?.canUpdate && (
          <Markdown>{`\`\`\`sh\n${engine.update.command}\n\`\`\``}</Markdown>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
function EngineRow({
  engine,
  canManage,
}: {
  engine: EngineStatus;
  canManage: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
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
    <section className="border-t pt-2" aria-label={engine.label}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:text-foreground transition-colors">
          {open ? (
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="font-medium">{engine.label}</span>
          <span className="text-muted-foreground">
            {engine.installed
              ? (engine.version ?? "Version unknown")
              : "Not installed"}
          </span>
          {metadata?.available && (
            <Badge variant="transitional">
              Update available: {engine.version} → {metadata.latestVersion}
            </Badge>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 space-y-2 pt-2">
          {engine.installed && canManage && metadata?.canUpdate && (
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => update.mutate()}
            >
              {update.isPending ? "Updating…" : `Update ${engine.label}`}
            </Button>
          )}
          {engine.installed && metadata?.latestPending && (
            <p className="text-sm text-muted-foreground">
              Checking for updates…
            </p>
          )}
          {engine.installed &&
            !metadata?.latestPending &&
            (!engine.version || !metadata?.latestVersion) && (
              <p className="text-sm text-muted-foreground">
                Update availability unknown
              </p>
            )}
          {engine.installed &&
            engine.version &&
            metadata?.latestVersion &&
            !metadata.available && (
              <p className="text-sm text-muted-foreground">Up to date</p>
            )}
          {(!engine.installed || !metadata?.canUpdate) && (
            <>
              <p className="text-sm text-muted-foreground">
                {engine.installed
                  ? "Update this installation with the command below."
                  : `Install ${engine.label} with the command below, then sign in.`}
              </p>
              <Markdown>{`\`\`\`sh\n${metadata?.command ?? engine.install}\n\`\`\``}</Markdown>
            </>
          )}
          {engine.installed && metadata?.canUpdate && !canManage && (
            <p className="text-sm text-muted-foreground">
              Sign in to Dispatch to update this CLI.
            </p>
          )}
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
          {engine.installed && <InstallationDetails engine={engine} />}
        </CollapsibleContent>
      </Collapsible>
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
