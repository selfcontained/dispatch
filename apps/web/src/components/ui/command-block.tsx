import { CopyButton } from "./copy-button";
import { cn } from "@/lib/utils";

/** Plain-text command or code with a copy button that copies it verbatim. */
export function CommandBlock({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  textClassName,
  testId,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  textClassName?: string;
  testId?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-1 rounded-sm border border-border bg-background/veil p-2",
        className
      )}
    >
      <pre
        className={cn(
          "max-h-40 min-w-0 flex-1 select-all overflow-auto whitespace-pre-wrap break-words px-1 font-mono text-label-sm leading-relaxed text-foreground",
          textClassName
        )}
        data-testid={testId}
      >
        {text}
      </pre>
      <CopyButton
        text={text}
        label={label}
        copiedLabel={copiedLabel}
        className="shrink-0"
        data-testid={testId ? `${testId}-copy` : undefined}
      />
    </div>
  );
}
