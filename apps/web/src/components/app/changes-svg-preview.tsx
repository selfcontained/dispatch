import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { api } from "@/lib/api";
import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

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
        <SegmentedControl
          value={view}
          onValueChange={onViewChange}
          aria-label={`SVG view: ${path}`}
        >
          <SegmentedControlItem value="preview">Preview</SegmentedControlItem>
          <SegmentedControlItem value="diff">Diff</SegmentedControlItem>
        </SegmentedControl>
        {view === "preview" && (
          <span className="text-body-sm text-muted-foreground">
            Current working tree
          </span>
        )}
      </div>
      {view === "diff" ? (
        children
      ) : preview.isPending ? (
        <LoadingSkeleton
          label="Loading preview…"
          className="w-auto p-6"
          rows={1}
          rowClassName="h-32"
        />
      ) : preview.isError ? (
        <LoadError
          thing="the preview"
          error={preview.error}
          retrying={preview.isFetching}
          onRetry={() => void preview.refetch()}
          className="m-3"
        />
      ) : preview.data?.kind === "svg" && preview.data.src ? (
        <div className="grid place-items-center overflow-auto p-6">
          <img
            src={preview.data.src}
            alt={path}
            className="max-h-[60vh] w-full max-w-lg object-contain"
          />
        </div>
      ) : (
        <p className="p-6 text-body-md text-muted-foreground">
          {preview.data?.message ??
            "SVG preview unavailable. Use Diff to inspect this file."}
        </p>
      )}
    </div>
  );
}
