import { Markdown } from "@/components/ui/markdown";

/** Shared title/description header used by every block renderer. */
export function BlockHeader({
  title,
  description,
}: {
  title?: string;
  description?: string;
}): JSX.Element | null {
  if (!title && !description) return null;
  return (
    <div className="mb-1.5">
      {title ? (
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      ) : null}
      {description ? (
        <Markdown variant="caption" className="line-clamp-none">
          {description}
        </Markdown>
      ) : null}
    </div>
  );
}
