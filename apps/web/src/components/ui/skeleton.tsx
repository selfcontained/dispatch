import { cn } from "@/lib/utils";

/** A placeholder the size of the content it stands in for, pulsing until it loads. */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted/70", className)}
      {...props}
    />
  );
}

export { Skeleton };
