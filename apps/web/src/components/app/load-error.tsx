import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** A failed load and its Retry, styled as the stream's error banner. */
export function LoadError({
  message,
  error,
  onRetry,
  retrying = false,
  className,
}: {
  message: string;
  /** The failure's own words, shown after the message. */
  error?: unknown;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-danger/line bg-danger/tint px-3 py-2 text-body-sm text-danger",
        className
      )}
    >
      <span className="min-w-0 break-words">
        {error ? `${message}: ${errorMessage(error)}` : message}
      </span>
      <Button
        type="button"
        size="xs"
        className="shrink-0"
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
