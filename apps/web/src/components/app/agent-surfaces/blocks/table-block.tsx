import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  Scalar,
  TableBlock,
  TableColumn,
} from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { ItemAction } from "@/components/app/agent-surfaces/blocks/item-action";
import type { SurfaceInteractionIndex } from "@/components/app/agent-surfaces/interaction-presentation";
import { isAllowedSurfaceUrl } from "@/components/app/agent-surfaces/surface-url";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

function formatCell(value: Scalar, format: TableColumn["format"]): string {
  if (value === null || value === undefined) return "—";
  if (format === "date" && typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
  }
  return String(value);
}

function Cell({
  value,
  column,
}: {
  value: Scalar;
  column: TableColumn;
}): JSX.Element {
  const text = formatCell(value, column.format);

  if (column.format === "badge") {
    const tone = column.badgeVariants?.[String(value)];
    return (
      <Badge
        variant="default"
        className={tone ? TONE_CLASSES[tone].badge : undefined}
      >
        {text}
      </Badge>
    );
  }
  if (column.format === "code") {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
        {text}
      </code>
    );
  }
  if (
    column.format === "url" &&
    typeof value === "string" &&
    isAllowedSurfaceUrl(value)
  ) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline decoration-primary/40 underline-offset-2"
      >
        {text}
      </a>
    );
  }
  return <span className="text-foreground">{text}</span>;
}

/** One row: primary columns inline, secondary columns always behind a
 * disclosure — the rail is a fixed width, not a responsive breakpoint, so
 * this doesn't vary with viewport size. Agents should reserve `secondary`
 * for verbose diagnostics; decision-critical values belong in `primary`. */
function TableRowView({
  row,
  primaryColumns,
  secondaryColumns,
  block,
  interactionProps,
  hasActionColumn,
}: {
  row: TableBlock["rows"][number];
  primaryColumns: TableColumn[];
  secondaryColumns: TableColumn[];
  block: TableBlock;
  interactionProps: Omit<
    React.ComponentProps<typeof ItemAction>,
    "action" | "itemId" | "blockId"
  >;
  hasActionColumn: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        data-row-id={row.id}
        className="border-b border-border/50 last:border-0"
      >
        {secondaryColumns.length > 0 ? (
          <td className="w-8 p-2 align-middle">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? "Hide details" : "Show details"}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-90"
                )}
              />
            </button>
          </td>
        ) : null}
        {primaryColumns.map((column) => (
          <td
            key={column.id}
            className={cn(
              "p-2 align-middle text-xs",
              column.align === "right" && "text-right",
              column.align === "center" && "text-center"
            )}
          >
            <Cell value={row.cells[column.id] ?? null} column={column} />
          </td>
        ))}
        {hasActionColumn ? (
          <td className="w-px min-w-32 p-2 text-right align-middle">
            {row.action ? (
              <ItemAction
                action={row.action}
                itemId={row.id}
                blockId={block.id}
                buttonClassName="whitespace-nowrap break-normal"
                ariaLabel={`${row.action.label} for ${formatCell(
                  row.cells[primaryColumns[0]?.id] ?? row.id,
                  primaryColumns[0]?.format
                )}`}
                {...interactionProps}
              />
            ) : null}
          </td>
        ) : null}
      </tr>
      {expanded && secondaryColumns.length > 0 ? (
        <tr className="border-b border-border/50 last:border-0">
          <td
            colSpan={primaryColumns.length + 1 + (hasActionColumn ? 1 : 0)}
            className="p-2 align-middle"
          >
            <dl className="ml-6 space-y-0.5">
              {secondaryColumns.map((column) => (
                <div
                  key={column.id}
                  className="flex items-center gap-1.5 text-[11px]"
                >
                  <dt className="shrink-0 text-muted-foreground">
                    {column.label}:
                  </dt>
                  <dd className="min-w-0">
                    <Cell
                      value={row.cells[column.id] ?? null}
                      column={column}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function TableBlockView({
  block,
  ...interactionProps
}: {
  block: TableBlock;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  const primaryColumns = block.columns.filter(
    (c) => c.priority !== "secondary"
  );
  const secondaryColumns = block.columns.filter(
    (c) => c.priority === "secondary"
  );
  // A table with only secondary columns still needs something visible.
  const effectivePrimary =
    primaryColumns.length > 0 ? primaryColumns : block.columns;
  const effectiveSecondary = primaryColumns.length > 0 ? secondaryColumns : [];
  const hasActionColumn = block.rows.some((row) => row.action);
  return (
    <div data-block-id={block.id} data-block-type="table">
      <BlockHeader
        title={block.title}
        description={block.description}
        count={block.showItemCount ? block.rows.length : undefined}
      />
      <div className="overflow-x-auto rounded-md border border-border/50">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              {effectiveSecondary.length > 0 ? (
                <th className="w-8 p-2" />
              ) : null}
              {effectivePrimary.map((column) => (
                <th
                  key={column.id}
                  className={cn(
                    "p-2 text-left align-middle font-medium",
                    column.align === "right" && "text-right",
                    column.align === "center" && "text-center"
                  )}
                >
                  {column.label}
                </th>
              ))}
              {hasActionColumn ? (
                <th className="w-px min-w-32 p-2 text-right align-middle font-medium">
                  Action
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <TableRowView
                key={row.id}
                row={row}
                primaryColumns={effectivePrimary}
                secondaryColumns={effectiveSecondary}
                block={block}
                interactionProps={interactionProps}
                hasActionColumn={hasActionColumn}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
