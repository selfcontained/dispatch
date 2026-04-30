import { cn } from "@/lib/utils";

type RadioIndicatorProps = {
  selected: boolean;
  className?: string;
};

export function RadioIndicator({
  selected,
  className,
}: RadioIndicatorProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        selected
          ? "border-primary bg-primary/20"
          : "border-muted-foreground/40",
        className
      )}
    >
      {selected ? (
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      ) : null}
    </span>
  );
}
