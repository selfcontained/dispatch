import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function CollapsibleSection({
  title,
  icon: Icon,
  visibleCount,
  totalCount,
  defaultOpen = true,
  headerAction,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  /** How many rows the caller is rendering — after any filtering or capping. */
  visibleCount: number;
  /**
   * How many exist in total. The section stays mounted while this is nonzero,
   * so a caller that renders no rows can still show a header and whatever
   * `headerAction` reaches. Defaults to `visibleCount`.
   */
  totalCount?: number;
  defaultOpen?: boolean;
  /** Rendered at the right edge of the header, beside the count badge. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen);

  const total = totalCount ?? visibleCount;
  if (total === 0) return null;

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex w-full items-center gap-1 pr-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <Icon className="h-3.5 w-3.5" />
          <span>{title}</span>
          <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
            {visibleCount === total ? total : `${visibleCount} / ${total}`}
          </span>
        </button>
        {headerAction}
      </div>
      {open ? <div className="pb-2">{children}</div> : null}
    </div>
  );
}
