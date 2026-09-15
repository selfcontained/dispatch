/**
 * The one place the composer's field contract lives: the box the textarea
 * and its highlight mirror share, and the rule for what counts as an
 * "@path" token. Both the picker (which opens on a token under the caret)
 * and the highlight layer (which paints every token) read from here, so a
 * change to one cannot light up one thing and pick another.
 */

/** The field's box: the mirror must wrap and pad exactly as the textarea does. */
export const COMPOSER_FIELD_BOX_CLASS =
  "max-h-48 min-h-10 px-2 py-2.5 text-sm [scrollbar-gutter:stable]";

export type AtToken = { query: string; start: number; end: number };

/** Whitespace ends a token; the field's newline included. */
function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * The "@partial/path" token ending at `caret`, if there is one: an "@" at
 * the start of the text or after whitespace, then no whitespace up to the
 * caret (slashes are the point), and nothing glued on after the caret. An
 * email-like "a@b" does not count. A scoped package path like
 * "@node_modules/@types/" is one token: the scan goes back to whitespace,
 * not to the nearest "@".
 */
export function atTokenAt(text: string, caret: number): AtToken | null {
  const end = Math.max(0, Math.min(caret, text.length));
  if (end < text.length && !isSpace(text[end])) return null;
  let start = end - 1;
  while (start >= 0 && !isSpace(text[start])) start -= 1;
  start += 1;
  if (start >= end || text[start] !== "@") return null;
  return { query: text.slice(start + 1, end), start, end };
}

/** One run of the field's text: plain, or an "@path" token. */
export type ComposerSegment = { text: string; token: boolean };

/**
 * Split the field's text into plain runs and tokens. Each whitespace
 * delimited word is asked the picker's own question (`atTokenAt` at its
 * end), so the highlight and the picker agree by construction.
 */
export function splitAtTokens(text: string): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i])) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && !isSpace(text[end])) end += 1;
    const token = atTokenAt(text, end);
    if (token && token.start === i) {
      if (i > last) segments.push({ text: text.slice(last, i), token: false });
      segments.push({ text: text.slice(i, end), token: true });
      last = end;
    }
    i = end;
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), token: false });
  return segments;
}
