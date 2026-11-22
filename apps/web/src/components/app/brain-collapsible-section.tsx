import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { CountBubble } from "@/components/ui/count-bubble";
import { RowButton } from "@/components/ui/row-button";

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
        <RowButton
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 rounded-none px-3 py-3 section-label hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <Icon className="h-3.5 w-3.5" />
          <span>{title}</span>
          <CountBubble
            className="ml-auto"
            count={
              visibleCount === total
                ? String(total)
                : `${visibleCount} / ${total}`
            }
          />
        </RowButton>
        {headerAction}
      </div>
      {open ? <div className="pb-2">{children}</div> : null}
    </div>
  );
}
