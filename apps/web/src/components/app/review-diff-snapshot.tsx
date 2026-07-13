import { cn } from "@/lib/utils";

type ReviewDiffSnapshotProps = { diff: string; className?: string };

/** A compact, read-only hunk styled to match the Changes diff view. */
export function ReviewDiffSnapshot({
  diff,
  className,
}: ReviewDiffSnapshotProps): JSX.Element {
  return (
    <div
      className={cn(
        "relative mt-3 overflow-hidden rounded-md border border-border/60 bg-[hsl(var(--diff-bg))]",
        className
      )}
    >
      <div className="changes-diff-view overflow-x-auto overscroll-x-contain font-mono text-[10px] leading-relaxed text-[hsl(var(--diff-fg))]">
        {diff.split("\n").map((line, index) => {
          const kind = line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+") && !line.startsWith("+++")
              ? "insert"
              : line.startsWith("-") && !line.startsWith("---")
                ? "delete"
                : "context";
          return (
            <div
              key={`${index}-${line}`}
              className={cn(
                "grid min-w-max grid-cols-[1.75rem_minmax(0,1fr)]",
                kind === "hunk" &&
                  "bg-[hsl(var(--diff-fg)/0.08)] text-[hsl(var(--diff-fg)/0.5)]",
                kind === "insert" && "bg-[hsl(var(--diff-add)/0.22)]",
                kind === "delete" && "bg-[hsl(var(--diff-delete)/0.22)]"
              )}
            >
              <span
                className={cn(
                  "border-r border-[hsl(var(--diff-fg)/0.1)] px-1 text-right text-[hsl(var(--diff-fg)/0.5)]",
                  kind === "insert" &&
                    "bg-[hsl(var(--diff-add)/0.28)] text-[hsl(var(--diff-fg))]",
                  kind === "delete" &&
                    "bg-[hsl(var(--diff-delete)/0.28)] text-[hsl(var(--diff-fg))]",
                  kind === "hunk" && "bg-[hsl(var(--diff-fg)/0.08)]"
                )}
              >
                {kind === "hunk" ? "" : line.slice(0, 1)}
              </span>
              <code className="whitespace-pre px-2">
                {kind === "hunk" ? line : line.slice(1)}
              </code>
            </div>
          );
        })}
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-[hsl(var(--diff-bg))] to-transparent" />
    </div>
  );
}
