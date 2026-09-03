import { Fragment, useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  Scalar,
  TableBlock,
  TableColumn,
} from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { ItemActions } from "@/components/app/agent-surfaces/blocks/item-actions";
import type { SurfaceInteractionIndex } from "@/components/app/agent-surfaces/interaction-presentation";
import {
  formatSurfaceTime,
  humanizeLabel,
} from "@/components/app/agent-surfaces/format";
import { isAllowedSurfaceUrl } from "@/components/app/agent-surfaces/surface-url";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

/** The rail is a fixed 400px, so the practical budget is 3 visible columns;
 * the schema enforces it for v2 documents and this constant is the renderer's
 * defensive fallback for anything that slips through. */
const MAX_PRIMARY_COLUMNS = 3;

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
    // Datetime instants get the renderer-owned compact treatment.
    return formatSurfaceTime(value).text;
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
        className={cn(
          "normal-case tracking-normal",
          tone ? TONE_CLASSES[tone].badge : undefined
        )}
      >
        {humanizeLabel(text)}
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

function cellAlignment(column: TableColumn): string | undefined {
  // Numbers right-align automatically so magnitudes line up; an explicit
  // align always wins.
  if (column.align === "right") return "text-right";
  if (column.align === "left") return "text-left";
  if (column.format === "number") return "text-right";
  return undefined;
}

/** A 2-column, action-free table is a key/value list wearing table chrome —
 * render it as the stat list it is: dim keys left, values emphasized right,
 * no header row, no rules. */
function KeyValueView({
  block,
  keyColumn,
  valueColumn,
}: {
  block: TableBlock;
  keyColumn: TableColumn;
  valueColumn: TableColumn;
}): JSX.Element {
  return (
    <dl className="space-y-1">
      {block.rows.map((row) => (
        <div
          key={row.id}
          data-row-id={row.id}
          className="flex items-baseline justify-between gap-3"
        >
          <dt className="shrink-0 text-xs text-muted-foreground">
            <Cell value={row.cells[keyColumn.id] ?? null} column={keyColumn} />
          </dt>
          <dd className="min-w-0 text-right text-xs font-medium">
            <Cell
              value={row.cells[valueColumn.id] ?? null}
              column={valueColumn}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

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
    React.ComponentProps<typeof ItemActions>,
    "actions" | "itemId" | "blockId" | "itemLabel"
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
    <Fragment>
      <tr
        data-row-id={row.id}
        className={cn(
          "border-b border-border/40 last:border-0",
          expanded && "border-b-0"
        )}
      >
        {secondaryColumns.length > 0 ? (
          <td className="w-6 py-1.5 pr-1 align-middle">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={`${expanded ? "Hide" : "Show"} details for ${rowLabel}`}
              className="h-6 w-6 p-0 text-muted-foreground [@media(pointer:coarse)]:min-h-11"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-90"
                )}
              />
            </Button>
          </td>
        ) : null}
        {primaryColumns.map((column, index) => (
          <td
            key={column.id}
            className={cn(
              "min-w-0 break-words py-1.5 pr-2 align-middle text-xs first:pl-0 last:pr-0",
              index > 0 && secondaryColumns.length === 0 && "pl-0",
              cellAlignment(column)
            )}
          >
            <Cell value={row.cells[column.id] ?? null} column={column} />
          </td>
        ))}
        {hasActionColumn ? (
          <td className="w-px py-1 pl-1 text-right align-middle">
            {row.actions?.length ? (
              <ItemActions
                actions={row.actions}
                itemId={row.id}
                blockId={block.id}
                itemLabel={rowLabel}
                {...interactionProps}
              />
            ) : null}
          </td>
        ) : null}
      </tr>
      {secondaryColumns.length > 0 ? (
        <tr
          id={detailsId}
          hidden={!expanded}
          className="border-b border-border/40 last:border-0"
        >
          <td
            colSpan={primaryColumns.length + 1 + (hasActionColumn ? 1 : 0)}
            className="pb-2 pl-6 pt-0.5 align-middle"
          >
            <dl className="space-y-0.5">
              {secondaryColumns.map((column) => (
                <div
                  key={column.id}
                  className="flex items-baseline gap-1.5 text-[11px]"
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
    </Fragment>
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
  const authoredPrimary = block.columns.filter(
    (c) => c.priority !== "secondary"
  );
  // Defensive demotion past the budget; column 1 (row identity) never demotes.
  const primaryColumns = authoredPrimary.slice(0, MAX_PRIMARY_COLUMNS);
  const secondaryColumns = [
    ...authoredPrimary.slice(MAX_PRIMARY_COLUMNS),
    ...block.columns.filter((c) => c.priority === "secondary"),
  ];
  // A table with only secondary columns still needs something visible.
  const effectivePrimary =
    primaryColumns.length > 0
      ? primaryColumns
      : block.columns.slice(0, MAX_PRIMARY_COLUMNS);
  const effectiveSecondary =
    primaryColumns.length > 0
      ? secondaryColumns
      : block.columns.slice(MAX_PRIMARY_COLUMNS);
  const hasActionColumn = block.rows.some((row) => row.actions?.length);
  const isKeyValue =
    block.columns.length === 2 &&
    effectiveSecondary.length === 0 &&
    !hasActionColumn;

  return (
    <div data-block-id={block.id} data-block-type="table">
      <BlockHeader
        title={block.title}
        description={block.description}
        count={block.showItemCount ? block.rows.length : undefined}
      />
      {isKeyValue ? (
        <KeyValueView
          block={block}
          keyColumn={block.columns[0]}
          valueColumn={block.columns[1]}
        />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border/40 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {effectiveSecondary.length > 0 ? (
                <th className="w-6 py-1.5 pr-1" />
              ) : null}
              {effectivePrimary.map((column) => (
                <th
                  key={column.id}
                  className={cn(
                    "py-1.5 pr-2 text-left align-middle font-medium first:pl-0 last:pr-0",
                    cellAlignment(column)
                  )}
                >
                  {column.label}
                </th>
              ))}
              {hasActionColumn ? <th className="w-px py-1.5 pl-1" /> : null}
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
      )}
    </div>
  );
}
