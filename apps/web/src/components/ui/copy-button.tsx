import type { ComponentProps } from "react";
import { Check, Copy, Download } from "lucide-react";
import { IconButton } from "./icon-button";
import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

type CopyIconButtonProps = Omit<
  ComponentProps<typeof IconButton>,
  "children" | "label" | "onClick" | "tooltip"
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
  size = "icon-sm",
  ...props
}: CopyIconButtonProps) {
  const Icon = copied ? Check : Copy;
  return (
    <IconButton
      {...props}
      size={size}
      label={copied ? copiedLabel : label}
      className={cn(className, copied && "text-success opacity-100")}
      onClick={onCopy}
      data-copied={copied}
    >
      {faceClassName ? (
        <span className={faceClassName}>
          <Icon className="size-icon-md" aria-hidden="true" />
        </span>
      ) : (
        <Icon aria-hidden="true" />
      )}
    </IconButton>
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
  size = "icon-sm",
}: {
  src: string;
  fileName: string;
  size?: ComponentProps<typeof IconButton>["size"];
}) {
  return (
    <IconButton asChild size={size} label="Download">
      <a href={src} download={fileName}>
        <Download className="size-icon-md" aria-hidden="true" />
      </a>
    </IconButton>
  );
}
