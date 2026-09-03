import { Markdown } from "@/components/ui/markdown";

/** Shared title/description header used by every block renderer. Block titles
 * get a real size step above item text (the typographic ramp: section label <
 * item text < block title), and counts render as quiet text — pill-shaped
 * attention belongs to state, not to a number the list below makes obvious. */
export function BlockHeader({
  title,
  description,
  count,
}: {
  title?: string;
  description?: string;
  count?: number;
}): JSX.Element | null {
  if (!title && !description && count === undefined) return null;
  return (
    <div className="mb-1.5">
      {title || count !== undefined ? (
        <div className="flex items-baseline gap-1.5">
          {title ? (
            <h3 className="text-[13px] font-semibold text-foreground">
              {title}
            </h3>
          ) : null}
          {count !== undefined ? (
            // Parenthesized so the numeral reads as part of the title line
            // rather than a stray detached digit.
            <span className="text-xs tabular-nums text-muted-foreground">
              ({count})
            </span>
          ) : null}
        </div>
      ) : null}
      {description ? (
        <Markdown variant="caption" className="line-clamp-none">
          {description}
        </Markdown>
      ) : null}
    </div>
  );
}
