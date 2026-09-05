// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo } from "react";

import type { Attachment, Turn } from "./contracts";

const CHIP_CLASS =
  "inline-flex max-w-[240px] items-center truncate rounded-[2px] border border-border bg-background px-1.5 py-0.5 text-[10.5px] text-foreground/80";

function PromptLineImpl({
  turn,
  onAttachmentClick,
}: {
  turn: Turn;
  onAttachmentClick?: (a: Attachment) => void;
}): JSX.Element {
  const attachments = turn.attachments ?? [];
  const contextChips = turn.contextChips ?? [];
  return (
    <div className="mb-3.5" data-testid="harness-prompt">
      <div className="flex items-start gap-[9px]">
        <span
          aria-hidden="true"
          className="select-none text-[13px] font-bold leading-[1.55] text-status-working"
        >
          ›
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-foreground">
          {turn.content}
        </p>
      </div>
      {contextChips.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-[5px] pl-[21px]">
          {contextChips.map((chip, i) => (
            <span key={`${chip.label}:${i}`} className={CHIP_CLASS}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2 pl-[21px]">
          {attachments.map((a, i) =>
            a.kind === "image" ? (
              <img
                key={`${a.url}:${i}`}
                src={a.url}
                alt={a.name ?? `Attached image ${i + 1}`}
                className="h-16 w-16 cursor-pointer rounded-[2px] object-cover hover:ring-2 hover:ring-status-working/50"
                onClick={() => onAttachmentClick?.(a)}
              />
            ) : (
              <span key={`${a.url}:${i}`} className={CHIP_CLASS}>
                {a.name ?? a.kind}
              </span>
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

export const PromptLine = memo(PromptLineImpl);
