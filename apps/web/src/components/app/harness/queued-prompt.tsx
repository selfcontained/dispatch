import type { HarnessQueuedPrompt } from "@dispatch/shared";

import { Button } from "@/components/ui/button";

const CHIP_CLASS =
  "inline-flex max-w-[240px] items-center truncate rounded-[2px] border border-border bg-background px-1.5 py-0.5 text-[10.5px] text-foreground/70";

function clip(text: string, max = 40): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A prompt that waits behind the running turn: the same prompt line,
 * dimmed, with what the reader can do about it. It becomes a real prompt
 * line (and a turn) the moment it starts.
 */
export function QueuedPrompt({
  prompt,
  busy,
  onSendNow,
  onRemove,
}: {
  prompt: HarnessQueuedPrompt;
  /** An action on this prompt is in flight. */
  busy: boolean;
  onSendNow?: (id: string) => void;
  onRemove?: (id: string) => void;
}): JSX.Element {
  const attachments = prompt.attachments ?? [];
  const excerpt = clip(prompt.text);
  return (
    <div
      className="mb-3.5"
      data-testid="harness-queued"
      data-queued-id={prompt.id}
    >
      <div className="flex items-start gap-[9px]">
        <span
          aria-hidden="true"
          className="select-none text-[13px] font-bold leading-[1.55] text-muted-foreground/60"
        >
          ›
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-foreground/60">
          {prompt.text}
        </p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[21px]">
        <span
          className="rounded-[2px] border border-status-waiting/40 bg-status-waiting/10 px-1.5 py-px text-[10px] uppercase tracking-wide text-status-waiting"
          data-testid="harness-queued-chip"
        >
          Queued
        </span>
        {prompt.senderName ? (
          <span className={CHIP_CLASS}>from {prompt.senderName}</span>
        ) : null}
        {attachments.map((a, i) => (
          <span key={`${a.type}:${i}`} className={CHIP_CLASS}>
            {a.type === "file"
              ? a.fileName
              : a.type === "link" || a.type === "pr"
                ? (a.title ?? a.url)
                : a.type}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onSendNow?.(prompt.id)}
            title="Interrupt the running turn and send this next"
            aria-label={`Send "${excerpt}" now, interrupting the current turn`}
            data-testid="harness-queued-send-now"
            className="h-6 px-1.5 text-[10.5px] text-status-working hover:text-status-working pointer-coarse:h-11 pointer-coarse:px-3"
          >
            Send now
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onRemove?.(prompt.id)}
            title="Drop this message from the queue"
            aria-label={`Remove "${excerpt}" from the queue`}
            data-testid="harness-queued-remove"
            className="h-6 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground pointer-coarse:h-11 pointer-coarse:px-3"
          >
            Remove
          </Button>
        </span>
      </div>
    </div>
  );
}
