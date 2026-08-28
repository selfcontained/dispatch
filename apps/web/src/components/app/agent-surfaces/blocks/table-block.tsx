import { useId, useState } from "react";
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
    if (Number.isNaN(parsed.getTime())) return value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      // Date-only values represent authored calendar days, not UTC instants.
      // Pin formatting to UTC so a viewer west of UTC cannot see yesterday.
      if (parsed.toISOString().slice(0, 10) !== value) return value;
      return parsed.toLocaleDateString(undefined, { timeZone: "UTC" });
    }
    return parsed.toLocaleDateString();
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

/** One row: primary columns stay visible and reflow into a labeled card when
 * the containing rail is narrow. Secondary columns remain behind a disclosure.
 * Agents should reserve `secondary` for verbose diagnostics; decision-critical
 * values belong in `primary`. */
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
  const detailsId = useId();
  const rowLabel = formatCell(
    row.cells[primaryColumns[0]?.id] ?? row.id,
    primaryColumns[0]?.format
  );

  return (
    <>
      <tr
        data-row-id={row.id}
        className="grid border-b border-border/50 p-2 last:border-0 md:table-row md:p-0"
      >
        {secondaryColumns.length > 0 ? (
          <td className="order-last flex justify-end px-2 py-1 align-middle md:table-cell md:w-8 md:p-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={`${expanded ? "Hide" : "Show"} details for ${rowLabel}`}
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
              "grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-2 px-2 py-1.5 align-middle text-xs md:table-cell md:p-2",
              column.align === "right" && "md:text-right",
              column.align === "center" && "md:text-center"
            )}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
              {column.label}
            </span>
            <span className="min-w-0 break-words">
              <Cell value={row.cells[column.id] ?? null} column={column} />
            </span>
          </td>
        ))}
        {hasActionColumn ? (
          <td
            className={cn(
              "min-w-0 items-start gap-2 px-2 py-1.5 text-right align-middle md:table-cell md:w-px md:min-w-32 md:p-2",
              row.action ? "grid grid-cols-[5rem_minmax(0,1fr)]" : "hidden"
            )}
          >
            {row.action ? (
              <>
                <span className="text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
                  Action
                </span>
                <ItemAction
                  action={row.action}
                  itemId={row.id}
                  blockId={block.id}
                  buttonClassName="w-full whitespace-normal break-words md:w-auto md:whitespace-nowrap md:break-normal"
                  ariaLabel={`${row.action.label} for ${formatCell(
                    row.cells[primaryColumns[0]?.id] ?? row.id,
                    primaryColumns[0]?.format
                  )}`}
                  {...interactionProps}
                />
              </>
            ) : null}
          </td>
        ) : null}
      </tr>
      {secondaryColumns.length > 0 ? (
        <tr
          id={detailsId}
          hidden={!expanded}
          className={cn(
            "border-b border-border/50 last:border-0",
            expanded ? "block md:table-row" : "hidden"
          )}
        >
          <td
            colSpan={primaryColumns.length + 1 + (hasActionColumn ? 1 : 0)}
            className="block p-2 align-middle md:table-cell"
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
      <div className="rounded-md border border-border/50">
        <div className="overflow-hidden md:overflow-x-auto">
          <table className="block w-full border-collapse md:table">
            <thead className="hidden md:table-header-group">
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
            <tbody className="block md:table-row-group">
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
    </div>
  );
}
