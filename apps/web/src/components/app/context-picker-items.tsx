import { FileText, Link2, X } from "lucide-react";

import {
  startupFileExt,
  startupLinkLabel,
} from "@/components/app/create-agent-dialog-clipboard";

export function ContextFileItem({
  file,
  preview,
  onRemove,
}: {
  file: File;
  preview: string | undefined;
  onRemove: () => void;
}) {
  return (
    <div className="group flex w-12 flex-col gap-0.5">
      <div className="relative h-12 w-12 overflow-hidden rounded-md border border-border/70 bg-muted/40">
        {preview ? (
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            <span className="text-[8px] font-medium tracking-wide">
              {startupFileExt(file.name)}
            </span>
          </div>
        )}
        <button
          type="button"
          className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
        >
          <span className="rounded-full border border-border/70 bg-background p-0.5">
            <X className="h-2.5 w-2.5" />
          </span>
        </button>
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

export function ContextLinkItem({
  link,
  onRemove,
}: {
  link: string;
  onRemove: () => void;
}) {
  const { host, rest } = startupLinkLabel(link);
  return (
    <div
      className="group relative flex h-12 max-w-[180px] flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 pr-7 leading-tight"
      title={link}
    >
      <div className="flex items-center gap-1 text-[10px] text-foreground">
        <Link2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{host}</span>
      </div>
      {rest ? (
        <span className="truncate text-[9px] text-muted-foreground">
          {rest}
        </span>
      ) : null}
      <button
        type="button"
        className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        onClick={onRemove}
        aria-label={`Remove ${link}`}
      >
        <span className="rounded-full border border-border/70 bg-background p-0.5">
          <X className="h-2.5 w-2.5" />
        </span>
      </button>
    </div>
  );
}
