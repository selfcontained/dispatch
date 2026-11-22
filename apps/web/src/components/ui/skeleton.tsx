import { cn } from "@/lib/utils";

/** A placeholder the size of the content it stands in for, pulsing until it loads. */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-surface-hover motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  );
}

/** A region's first load. Pass children where rows aren't the content's shape. */
function LoadingSkeleton({
  label,
  rows = 3,
  rowClassName,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** What is loading, as read out: "Loading jobs…". */
  label: string;
  rows?: number;
  rowClassName?: string;
}): JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn("w-full space-y-2", className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {children ??
        Array.from({ length: rows }, (_, row) => (
          <Skeleton key={row} className={cn("h-10", rowClassName)} />
        ))}
    </div>
  );
}

export { LoadingSkeleton, Skeleton };
