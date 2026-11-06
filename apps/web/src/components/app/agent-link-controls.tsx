import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyText } from "@/hooks/use-copy";

export function AgentLinkControls({
  url,
  copyLabel,
  copiedLabel,
  dismissLabel,
  dismissTitle = dismissLabel,
  onDismiss,
}: {
  url: string;
  copyLabel: string;
  copiedLabel: string;
  dismissLabel: string;
  dismissTitle?: string;
  onDismiss: () => void;
}) {
  const [copied, copyText] = useCopyText();
  return (
    <div
      data-agent-control="true"
      className="flex shrink-0 items-center"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        className="text-muted-foreground/60 hover:text-foreground"
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? copiedLabel : copyLabel}
        title={copied ? copiedLabel : copyLabel}
        onClick={() => copyText(url)}
      >
        {copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        className="text-muted-foreground/60 hover:text-foreground"
        variant="ghost"
        size="icon-sm"
        aria-label={dismissLabel}
        title={dismissTitle}
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function AgentMetadataLink({
  children,
  className,
  ...props
}: ComponentProps<"a">) {
  return (
    <a
      {...props}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-sm font-mono text-xs leading-4 text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <span className="truncate">{children}</span>
      <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
    </a>
  );
}
