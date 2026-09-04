import { FileText, Paperclip } from "lucide-react";

import { ContextChip } from "@/components/app/context-picker-items";
import { type ChatDraftFile } from "@/lib/chat-draft";
import { cn } from "@/lib/utils";

/** The `pasted.txt` chip: a long paste turned into a file, with a way back. */
export function PastedTextChip({
  file,
  lines,
  onKeepInline,
  onRemove,
  status,
}: {
  file: File;
  lines: number;
  onKeepInline: () => void;
  onRemove: () => void;
  status?: "uploading" | "failed";
}): JSX.Element {
  return (
    <ContextChip
      icon={<FileText />}
      title={file.name}
      subtitle={
        status === "failed"
          ? "Upload failed"
          : status === "uploading"
            ? "Uploading…"
            : `${lines} line${lines === 1 ? "" : "s"}`
      }
      action={
        status ? null : (
          <button
            type="button"
            onClick={onKeepInline}
            className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-foreground"
            data-testid="chat-attachment-keep-inline"
          >
            keep inline
          </button>
        )
      }
      onRemove={onRemove}
      removeLabel={`Remove ${file.name}`}
      tooltip={`${file.name} — pasted text, ${lines} lines`}
      className={cn(status === "failed" && "border-destructive/60")}
      testId="chat-attachment-chip-pasted"
    />
  );
}

/**
 * A file the draft remembers but cannot bring back: a picked file (only the
 * name survives a reload) or a paste whose text was dropped to fit the
 * draft's size cap. Inert apart from removal; the composer holds the send
 * until it is re-attached or removed.
 */
export function DraftPlaceholderChip({
  entry,
  onRemove,
}: {
  entry: ChatDraftFile;
  onRemove: () => void;
}): JSX.Element {
  const wasPaste = entry.pasted === null;
  return (
    <ContextChip
      icon={wasPaste ? <FileText /> : <Paperclip />}
      title={entry.name}
      subtitle={
        wasPaste ? "Too large to keep — paste again" : "Needs re-attaching"
      }
      onRemove={onRemove}
      removeLabel={`Remove ${entry.name}`}
      tooltip={
        wasPaste
          ? `${entry.name} — the pasted text was too large to keep across a reload`
          : `${entry.name} — files can't be kept across a reload; attach it again`
      }
      className="border-dashed opacity-70"
      testId="chat-attachment-chip-placeholder"
    />
  );
}
