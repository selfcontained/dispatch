import { formatCount } from "@/lib/format";
import { Panel } from "@/components/ui/card";
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
    <Panel>
      <p className="break-words text-body-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 break-words text-heading-lg sm:text-display",
          variant === "warning" ? "text-danger" : "text-foreground"
        )}
      >
        {typeof value === "number" ? formatCount(value) : value}
      </p>
      {sub && (
        <p className="mt-1 break-words text-body-sm text-muted-foreground">
          {sub}
        </p>
      )}
    </Panel>
  );
}
