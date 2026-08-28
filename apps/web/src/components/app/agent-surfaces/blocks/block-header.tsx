import { Markdown } from "@/components/ui/markdown";
import { Badge } from "@/components/ui/badge";

/** Shared title/description header used by every block renderer. */
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
        <div className="flex items-center gap-1.5">
          {title ? (
            <h3 className="text-xs font-semibold text-foreground">{title}</h3>
          ) : null}
          {count !== undefined ? (
            <Badge className="px-1.5 py-0 text-[10px]">{count}</Badge>
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
