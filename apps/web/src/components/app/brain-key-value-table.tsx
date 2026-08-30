import { formatPrimitive } from "@/components/app/brain-card-shared";
import { cn } from "@/lib/utils";

export function KeyValueTable({ value }: { value: unknown }): JSX.Element {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const fmt = formatPrimitive(value);
    return (
      <span className={cn("text-xs font-mono", fmt.className)}>{fmt.text}</span>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return (
      <span className="text-xs font-mono text-muted-foreground">{"{}"}</span>
    );
  }

  return (
    <div className="space-y-px">
      {entries.map(([key, val]) => {
        const fmt = formatPrimitive(val);
        return (
          <div
            key={key}
            className="flex gap-2 text-xs font-mono leading-relaxed min-w-0"
          >
            <span className="text-sky-400 shrink-0">{key}</span>
            <span className={cn(fmt.className, "whitespace-nowrap")}>
              {fmt.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
