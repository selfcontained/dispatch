import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A pane with nothing in it. An empty list inside a populated screen gets
 * one muted line instead.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** At most one. */
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-1 px-6 py-8 text-center",
        className
      )}
      {...props}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="mb-2 size-6 shrink-0 text-muted-foreground"
        />
      ) : null}
      <p className="text-heading-sm text-foreground">{title}</p>
      {description ? (
        <p className="max-w-sm break-words text-body-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
