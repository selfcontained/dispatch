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
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

function formatCell(value: Scalar, format: TableColumn["format"]): string {
  if (value === null || value === undefined) return "—";
  if (format === "date" && typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
  }
  return String(value);
}

function isAllowedTableUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
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
    isAllowedTableUrl(value)
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
}: {
  row: TableBlock["rows"][number];
  primaryColumns: TableColumn[];
  secondaryColumns: TableColumn[];
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
      </tr>
      {expanded && secondaryColumns.length > 0 ? (
        <tr className="border-b border-border/50 last:border-0">
          <td colSpan={primaryColumns.length + 1} className="p-2 align-middle">
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

export function TableBlockView({ block }: { block: TableBlock }): JSX.Element {
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

  return (
    <div data-block-id={block.id} data-block-type="table">
      <BlockHeader title={block.title} description={block.description} />
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
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <TableRowView
                key={row.id}
                row={row}
                primaryColumns={effectivePrimary}
                secondaryColumns={effectiveSecondary}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
