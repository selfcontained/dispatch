import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Work in flight. For a list or pane's first load use a Skeleton; a pending
 * Button shows its own.
 */
export function Spinner({
  label,
  className,
}: {
  /** Set it where nothing nearby says what is happening. */
  label?: string;
  className?: string;
}): JSX.Element {
  return (
    <LoaderCircle
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "size-icon-md shrink-0 animate-spin motion-reduce:animate-none",
        className
      )}
    />
  );
}
