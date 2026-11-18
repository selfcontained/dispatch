import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { agentDiffQueryKey } from "@/hooks/use-agent-diff";

/** Preview the current working tree only; the existing diff stays the default. */
export function ChangesSvgPreview({
  agentId,
  workspace,
  path,
  children,
  view,
  onViewChange,
}: {
  agentId: string;
  workspace: string;
  path: string;
  children: ReactNode;
  view: string;
  onViewChange: (view: string) => void;
}) {
  const preview = useQuery({
    queryKey: [...agentDiffQueryKey(agentId), "svg-preview", workspace, path],
    queryFn: ({ signal }) =>
      api<{ kind: string; src?: string; message?: string }>(
        `/api/v1/agents/${encodeURIComponent(agentId)}/workspace?${new URLSearchParams({ workspace, path, file: "true" })}`,
        { signal }
      ),
    enabled: view === "preview",
    retry: false,
  });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <ToggleGroup
          type="single"
          size="sm"
          value={view}
          onValueChange={(value) => {
            if (value) onViewChange(value);
          }}
          aria-label={`SVG view: ${path}`}
        >
          <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
          <ToggleGroupItem value="diff">Diff</ToggleGroupItem>
        </ToggleGroup>
        {view === "preview" && (
          <span className="text-xs text-muted-foreground">
            Current working tree
          </span>
        )}
      </div>
      {view === "diff" ? (
        children
      ) : preview.isPending ? (
        <p className="p-6 text-sm text-muted-foreground">Loading preview…</p>
      ) : preview.isError ? (
        <div role="alert" className="p-6 text-sm">
          {preview.error.message}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preview.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : preview.data?.kind === "svg" && preview.data.src ? (
        <div className="grid place-items-center overflow-auto p-6">
          <img
            src={preview.data.src}
            alt={path}
            className="max-h-[60vh] w-full max-w-lg object-contain"
          />
        </div>
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          {preview.data?.message ??
            "SVG preview unavailable. Use Diff to inspect this file."}
        </p>
      )}
    </div>
  );
}
