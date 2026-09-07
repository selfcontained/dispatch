import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** One run of the field's text: plain, or an "@path" token the picker filled. */
export type ComposerSegment = { text: string; token: boolean };

/**
 * Split the field's text into plain runs and "@path" tokens: an "@" at
 * the start or after whitespace, up to the next whitespace. The same
 * boundary rule the picker uses, so what it filled is what lights up; an
 * "@" inside a word (an email) stays plain.
 */
export function splitAtTokens(text: string): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  const re = /(^|\s)(@[^\s]+)/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last)
      segments.push({ text: text.slice(last, start), token: false });
    segments.push({ text: match[2], token: true });
    last = start + match[2].length;
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), token: false });
  return segments;
}

/**
 * A mirror of the field laid over it: the same text in the same box, all
 * of it transparent except the "@path" tokens, which paint over the
 * field's own glyphs in the working color. The field keeps the caret,
 * selection, and every event; this layer takes no pointer input and
 * follows the field's scroll.
 */
export function ComposerHighlights({
  text,
  scrollTop,
  className,
}: {
  text: string;
  scrollTop: number;
  className?: string;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = scrollTop;
  }, [scrollTop, text]);
  const segments = splitAtTokens(text);
  if (!segments.some((s) => s.token)) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="chat-composer-highlights"
      className={cn(
        "pointer-events-none absolute inset-0 z-[1] overflow-hidden whitespace-pre-wrap break-words text-transparent",
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
}
