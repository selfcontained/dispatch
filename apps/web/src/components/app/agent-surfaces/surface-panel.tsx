import { useId, useMemo } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import type {
  Surface,
  SurfaceBlock,
} from "@/components/app/agent-surfaces/types";
import {
  SURFACE_FOOTER_BLOCK_ID,
  SURFACE_SCHEMA_VERSION,
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
import { FormBlockView } from "@/components/app/agent-surfaces/blocks/form-block";
import { SectionBlockView } from "@/components/app/agent-surfaces/blocks/section-block";
import { SlotActions } from "@/components/app/agent-surfaces/blocks/slot-actions";

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
      return (
        <ListBlockView
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
    case "table":
      return (
        <TableBlockView
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
    case "status":
      return <StatusBlockView block={block} />;
    case "progress":
      return <ProgressBlockView block={block} />;
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
    case "section":
      return (
        <SectionBlockView
          block={block}
          agentId={agentId}
          surfaceId={surfaceId}
          surfaceRevision={surfaceRevision}
          interactions={interactions}
          onRequestRefresh={onRequestRefresh}
          readOnly={readOnly}
          idPrefix={idPrefix}
        >
          {block.blocks.map((child) => (
            <BlockRenderer
              key={child.id}
              block={child}
              agentId={agentId}
              surfaceId={surfaceId}
              surfaceRevision={surfaceRevision}
              interactions={interactions}
              onRequestRefresh={onRequestRefresh}
              readOnly={readOnly}
              idPrefix={idPrefix}
            />
          ))}
        </SectionBlockView>
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

  // Documents authored under an older schema render a notice instead of a
  // best-effort partial view — the feature is pre-stable and the owning agent
  // can recreate the tab under the current contract.
  if (surface.schemaVersion !== SURFACE_SCHEMA_VERSION) {
    return (
      <div
        data-testid="surface-panel"
        data-surface-id={surface.id}
        data-surface-revision={surface.revision}
        className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground"
      >
        <AlertTriangle className="h-5 w-5 text-status-waiting" />
        <p>
          This tab uses an older surface format. Ask the agent to recreate it.
        </p>
      </div>
    );
  }

  const readOnly = surface.lifecycle === "frozen";
  const shared = {
    agentId,
    surfaceId: surface.id,
    surfaceRevision: surface.revision,
    interactions,
    onRequestRefresh,
    readOnly,
    idPrefix,
  };
  const hasHeader = !!(surface.header?.status || surface.header?.progress);

  return (
    <div
      data-testid="surface-panel"
      data-surface-id={surface.id}
      data-surface-revision={surface.revision}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
    >
      {readOnly ? (
        <p className="mb-3 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          This tab is archived and read-only.
        </p>
      ) : null}
      {hasHeader ? (
        <div
          data-testid="surface-header"
          className="mb-4 space-y-3 border-b border-border/40 pb-4"
        >
          {surface.header?.status ? (
            <StatusBlockView block={surface.header.status} />
          ) : null}
          {surface.header?.progress ? (
            <ProgressBlockView block={surface.header.progress} />
          ) : null}
        </div>
      ) : null}
      {surface.blocks.length === 0 && !hasHeader ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <div className="flex flex-col">
          {surface.blocks.map((block, index) => (
            <div
              key={block.id}
              className={
                index > 0 ? "mt-5 border-t border-border/30 pt-5" : undefined
              }
            >
              <BlockRenderer block={block} {...shared} />
            </div>
          ))}
        </div>
      )}
      {surface.footer?.actions.length ? (
        <div
          data-testid="surface-footer"
          className="mt-5 border-t border-border/40 pt-3"
        >
          <SlotActions
            blockId={SURFACE_FOOTER_BLOCK_ID}
            actions={surface.footer.actions}
            {...shared}
          />
        </div>
      ) : null}
    </div>
  );
}
