import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  sub,
  variant,
}: {
  label: string;
  value: string | number;
  sub?: string;
  variant?: "warning";
}) {
  return (
    <div className="min-w-[7rem] max-w-[14rem] flex-1 basis-[7rem] rounded-md border border-border bg-surface-subtle px-2 py-2 sm:px-4 sm:py-3">
      <p className="text-label-xs sm:text-body-sm text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 sm:mt-1 text-heading-md sm:text-display",
          variant === "warning" ? "text-danger" : "text-foreground"
        )}
      >
        {typeof value === "number" ? formatCount(value) : value}
      </p>
      {sub && (
        <p className="mt-0.5 text-label-xs sm:text-body-sm text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}
