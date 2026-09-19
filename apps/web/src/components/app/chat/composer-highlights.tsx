import { forwardRef } from "react";

import { cn } from "@/lib/utils";

import { COMPOSER_FIELD_BOX_CLASS, splitAtTokens } from "./composer-tokens";

export { splitAtTokens } from "./composer-tokens";

/**
 * A mirror of the field laid over it: the same text in the same box, with
 * the "@path" tokens painted in the working color. While a token is on
 * screen the field draws its text transparent and this layer draws every
 * glyph once, so nothing halos; the field keeps the caret, the selection,
 * and every event. This layer takes no pointer input, and the host keeps
 * its scroll offset in step with the field's.
 */
export const ComposerHighlights = forwardRef<
  HTMLDivElement,
  {
    text: string;
    /** Mirrors the field's disabled dimming. */
    disabled?: boolean;
    className?: string;
  }
>(function ComposerHighlights({ text, disabled = false, className }, ref) {
  const segments = splitAtTokens(text);
  if (!segments.some((s) => s.token)) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="chat-composer-highlights"
      className={cn(
        "pointer-events-none absolute inset-0 z-[1] overflow-hidden whitespace-pre-wrap break-words text-foreground",
        COMPOSER_FIELD_BOX_CLASS,
        disabled && "opacity-50",
        className
      )}
    >
      {segments.map((segment, i) =>
        segment.token ? (
          <span
            key={i}
            data-testid="chat-composer-token"
            className="rounded-sm bg-status-working/15 text-status-working"
          >
            {segment.text}
          </span>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      )}
      {/* A trailing newline needs a glyph to keep its line's height. */}
      {text.endsWith("\n") ? "​" : null}
    </div>
  );
});

/** Whether the field currently holds a token the mirror will paint. */
export function hasAtTokens(text: string): boolean {
  return splitAtTokens(text).some((s) => s.token);
}
