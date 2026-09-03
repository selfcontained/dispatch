import { useState } from "react";
import { FileText, Paperclip, Pin } from "lucide-react";

import { ContextChip } from "@/components/app/context-picker-items";
import { type AgentPin } from "@/components/app/types";
import { type ChatDraftFile } from "@/lib/chat-draft";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Pins the composer can attach: addressable by id, and not a button. */
export function attachablePins(pins: AgentPin[]): AgentPin[] {
  return pins.filter((pin) => !!pin.id && pin.type !== "shortcut");
}

export function PinChip({
  pin,
  onRemove,
}: {
  pin: AgentPin;
  onRemove: () => void;
}): JSX.Element {
  return (
    <ContextChip
      icon={<Pin />}
      title={pin.label}
      subtitle={pin.value}
      onRemove={onRemove}
      removeLabel={`Remove pin ${pin.label}`}
      tooltip={`${pin.label}: ${pin.value}`}
      testId="chat-attachment-chip-pin"
    />
  );
}

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

/**
 * The paperclip's sibling: a popover listing the agent's pins so one can ride
 * along with the message. Already-attached pins stay listed but inert.
 */
export function PinPickerButton({
  pins,
  attachedIds,
  disabled,
  onPick,
}: {
  pins: AgentPin[];
  attachedIds: ReadonlySet<string>;
  disabled: boolean;
  onPick: (pin: AgentPin) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const candidates = attachablePins(pins);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          title="Attach a pin"
          aria-label="Attach a pin"
          data-testid="chat-composer-pin-button"
          className="h-7 w-7 shrink-0 text-muted-foreground pointer-coarse:h-11 pointer-coarse:min-h-11 pointer-coarse:w-11 pointer-coarse:min-w-11"
        >
          <Pin className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-72 p-1"
        data-testid="chat-composer-pin-picker"
      >
        {candidates.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            No pins to attach yet.
          </div>
        ) : (
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {candidates.map((pin) => {
              const attached = attachedIds.has(pin.id!);
              return (
                <button
                  key={pin.id}
                  type="button"
                  disabled={attached}
                  onClick={() => {
                    onPick(pin);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-white/[0.1] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                  data-testid="chat-composer-pin-option"
                  data-pin-id={pin.id}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground/80">
                      {pin.label}
                    </span>
                    {attached ? (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        attached
                      </span>
                    ) : null}
                  </span>
                  <span className="w-full truncate text-xs text-foreground">
                    {pin.value}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
