import type { ReactNode } from "react";
import {
  AlertTriangle,
  FileText,
  Link2,
  Loader2,
  MessageCircle,
  X,
} from "lucide-react";

import {
  startupFileExt,
  startupLinkLabel,
} from "@/components/app/create-agent-dialog-clipboard";
import { cn } from "@/lib/utils";

/** The × that hangs off a chip's top-right corner. */
export function ChipRemoveButton({
  label,
  onRemove,
  testId,
  compact = false,
}: {
  label: string;
  onRemove: () => void;
  testId?: string;
  /** A smaller hit area, for a chip whose body is itself clickable. */
  compact?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "absolute flex items-start justify-end rounded-full text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100",
        compact
          ? "-right-0.5 -top-0.5 z-10 h-6 w-6 p-0.5"
          : "-right-2 -top-2 h-10 w-10 p-2"
      )}
      onClick={onRemove}
      aria-label={label}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <span className="rounded-full border border-border/70 bg-background p-0.5">
        <X className="h-2.5 w-2.5" />
      </span>
    </button>
  );
}

export type ContextFileStatus = "uploading" | "failed";

export function ContextFileItem({
  file,
  preview,
  onRemove,
  status,
  onOpen,
  noteCount,
}: {
  file: File;
  preview: string | undefined;
  onRemove: () => void;
  /** Upload state, for composers that upload on send. */
  status?: ContextFileStatus;
  /** Opens the image for markup. */
  onOpen?: () => void;
  /** Markup notes saved on this image. */
  noteCount?: number;
}) {
  return (
    <div
      className="group flex w-12 flex-col gap-0.5"
      data-testid="context-file-item"
      data-file-name={file.name}
      data-status={status}
    >
      <div
        className={cn(
          "relative h-12 w-12 overflow-hidden rounded-md border bg-muted/40",
          status === "failed" ? "border-destructive/60" : "border-border/70"
        )}
        title={status === "failed" ? `Upload failed: ${file.name}` : file.name}
      >
        {preview && onOpen ? (
          <button
            type="button"
            className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label={`Mark up ${file.name}`}
            onClick={onOpen}
          >
            <img src={preview} alt="" className="h-full w-full object-cover" />
          </button>
        ) : preview ? (
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            <span className="text-[8px] font-medium tracking-wide">
              {startupFileExt(file.name)}
            </span>
          </div>
        )}
        {status ? (
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center bg-background/70",
              status === "failed" ? "text-destructive" : "text-foreground"
            )}
          >
            {status === "failed" ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
          </div>
        ) : null}
        {noteCount ? (
          <span
            className="pointer-events-none absolute bottom-0.5 left-0.5 flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground shadow"
            data-testid="context-file-note-count"
            aria-label={`${noteCount} ${noteCount === 1 ? "note" : "notes"}`}
          >
            <MessageCircle className="h-2.5 w-2.5" aria-hidden="true" />
            {noteCount}
          </span>
        ) : null}
        <ChipRemoveButton
          label={`Remove ${file.name}`}
          onRemove={onRemove}
          compact={!!onOpen}
        />
      </div>
      <span
        className="w-full truncate text-[8px] leading-tight text-muted-foreground"
        title={file.name}
      >
        {file.name}
      </span>
    </div>
  );
}

/**
 * A horizontal chip with an icon, a title line and an optional second line;
 * the shape a link or a pin takes. `action` sits in the second line for a
 * chip that offers something besides removal.
 */
export function ContextChip({
  icon,
  title,
  subtitle,
  action,
  onRemove,
  removeLabel,
  tooltip,
  className,
  testId,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string | null;
  action?: ReactNode;
  onRemove: () => void;
  removeLabel: string;
  tooltip?: string;
  className?: string;
  testId?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "group relative flex h-12 max-w-[180px] flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 pr-7 leading-tight",
        className
      )}
      title={tooltip ?? title}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <div className="flex items-center gap-1 text-[10px] text-foreground">
        <span className="shrink-0 text-muted-foreground [&>svg]:h-2.5 [&>svg]:w-2.5">
          {icon}
        </span>
        <span className="truncate font-medium">{title}</span>
      </div>
      {subtitle || action ? (
        <div className="flex min-w-0 items-center gap-1 text-[9px] text-muted-foreground">
          {subtitle ? <span className="truncate">{subtitle}</span> : null}
          {action}
        </div>
      ) : null}
      <ChipRemoveButton label={removeLabel} onRemove={onRemove} />
    </div>
  );
}

export function ContextLinkItem({
  link,
  onRemove,
}: {
  link: string;
  onRemove: () => void;
}) {
  const { host, rest } = startupLinkLabel(link);
  return (
    <ContextChip
      icon={<Link2 />}
      title={host}
      subtitle={rest || null}
      onRemove={onRemove}
      removeLabel={`Remove ${link}`}
      tooltip={link}
      testId="context-link-item"
    />
  );
}
