import type { ComponentProps } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "./button";
import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

type CopyIconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "onClick"
> & {
  copied: boolean;
  onCopy: () => void;
  label?: string;
  copiedLabel?: string;
  faceClassName?: string;
};

/** Shared icon-only feedback for clipboard actions, including image copying. */
export function CopyIconButton({
  copied,
  onCopy,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  faceClassName,
  ...props
}: CopyIconButtonProps) {
  return (
    <Button
      {...props}
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7 text-muted-foreground hover:text-foreground",
        className,
        copied && "text-status-working opacity-100"
      )}
      onClick={onCopy}
      title={copied ? copiedLabel : label}
      aria-label={copied ? copiedLabel : label}
      data-copied={copied}
    >
      <span className={faceClassName}>
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </span>
    </Button>
  );
}

export function CopyButton({
  text,
  ...props
}: Omit<CopyIconButtonProps, "copied" | "onCopy"> & { text: string }) {
  const [copied, copyText] = useCopyText();
  return (
    <CopyIconButton {...props} copied={copied} onCopy={() => copyText(text)} />
  );
}

export function DownloadButton({
  src,
  fileName,
}: {
  src: string;
  fileName: string;
}) {
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
    >
      <a href={src} download={fileName} title="Download" aria-label="Download">
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
}
