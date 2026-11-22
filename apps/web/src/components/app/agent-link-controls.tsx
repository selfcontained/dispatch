import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy";
import { IconButton } from "@/components/ui/icon-button";

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
      <IconButton
        className="text-faint hover:text-foreground"
        size="icon-sm"
        label={copied ? copiedLabel : copyLabel}
        onClick={() => copyText(url)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </IconButton>
      <IconButton
        tooltip={dismissTitle}
        className="text-faint hover:text-foreground"
        size="icon-sm"
        label={dismissLabel}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}

export const AgentMetadataLink = forwardRef<
  HTMLAnchorElement,
  ComponentPropsWithoutRef<"a">
>(({ children, className, ...props }, ref) => {
  return (
    <a
      ref={ref}
      {...props}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-sm font-mono text-body-sm leading-4 text-foreground hover:underline focus-ring",
        className
      )}
    >
      <span className="truncate">{children}</span>
      <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
    </a>
  );
});
AgentMetadataLink.displayName = "AgentMetadataLink";
