import { useId, useMemo } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import type {
  Surface,
  SurfaceBlock,
} from "@/components/app/agent-surfaces/types";
import {
  indexInteractions,
  type SurfaceInteractionIndex,
} from "@/components/app/agent-surfaces/interaction-presentation";
import { TextBlockView } from "@/components/app/agent-surfaces/blocks/text-block";
import { ListBlockView } from "@/components/app/agent-surfaces/blocks/list-block";
import { TableBlockView } from "@/components/app/agent-surfaces/blocks/table-block";
import { StatusBlockView } from "@/components/app/agent-surfaces/blocks/status-block";
import { ProgressBlockView } from "@/components/app/agent-surfaces/blocks/progress-block";
import { ActionsBlockView } from "@/components/app/agent-surfaces/blocks/actions-block";
import { FormBlockView } from "@/components/app/agent-surfaces/blocks/form-block";

function UnsupportedBlockView({
  blockType,
}: {
  blockType: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-status-waiting/40 bg-status-waiting/10 p-2 text-xs text-status-waiting">
      This tab contains an unsupported block type: <code>{blockType}</code>
    </div>
  );
}

function BlockRenderer({
  block,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
}: {
  block: SurfaceBlock;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  switch (block.type) {
    case "text":
      return <TextBlockView block={block} />;
    case "list":
      return <ListBlockView block={block} />;
    case "table":
      return <TableBlockView block={block} />;
    case "status":
      return <StatusBlockView block={block} />;
    case "progress":
      return <ProgressBlockView block={block} />;
    case "actions":
      return (
        <ActionsBlockView
          block={block}
          agentId={agentId}
          surfaceId={surfaceId}
          surfaceRevision={surfaceRevision}
          interactions={interactions}
          onRequestRefresh={onRequestRefresh}
          readOnly={readOnly}
          idPrefix={idPrefix}
        />
      );
    case "form":
      return (
        <FormBlockView
          block={block}
          agentId={agentId}
          surfaceId={surfaceId}
          surfaceRevision={surfaceRevision}
          interactions={interactions}
          onRequestRefresh={onRequestRefresh}
          readOnly={readOnly}
          idPrefix={idPrefix}
        />
      );
    default: {
      // Keep this assignment so adding a SurfaceBlock variant requires an
      // explicit renderer. The fallback remains visible if malformed wire
      // data reaches the client at runtime.
      const exhaustiveBlock: never = block;
      return (
        <UnsupportedBlockView
          blockType={String(
            (exhaustiveBlock as { type?: unknown }).type ?? "unknown"
          )}
        />
      );
    }
  }
}

export function SurfacePanel({
  agentId,
  surface,
  isLoading,
  isError,
  onRequestRefresh,
}: {
  agentId: string;
  surface: Surface | undefined;
  isLoading: boolean;
  isError: boolean;
  onRequestRefresh: () => Promise<void>;
}): JSX.Element {
  // One id namespace per mounted SurfacePanel instance, so form/action ids
  // and names stay unique even if the same surface (and so the same block
  // and field ids) happens to be rendered by more than one panel at once.
  const idPrefix = useId();
  // Built from the server payload rather than held in component state, so a
  // remounted panel hydrates pending/settled controls from the durable
  // records immediately instead of re-arming them.
  const interactions = useMemo(
    () => indexInteractions(surface?.latestInteractions),
    [surface?.latestInteractions]
  );

  if (isLoading && !surface) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <AlertTriangle className="h-5 w-5 text-status-blocked" />
        <p>Couldn't load this tab.</p>
        <button
          type="button"
          onClick={onRequestRefresh}
          className="text-xs text-primary underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!surface) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This tab is no longer available.
      </div>
    );
  }

  return (
    <div
      data-testid="surface-panel"
      data-surface-id={surface.id}
      data-surface-revision={surface.revision}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3"
    >
      {surface.lifecycle === "frozen" ? (
        <p className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          This tab is archived and read-only.
        </p>
      ) : null}
      {surface.blocks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        surface.blocks.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            agentId={agentId}
            surfaceId={surface.id}
            surfaceRevision={surface.revision}
            interactions={interactions}
            onRequestRefresh={onRequestRefresh}
            readOnly={surface.lifecycle === "frozen"}
            idPrefix={idPrefix}
          />
        ))
      )}
    </div>
  );
}
