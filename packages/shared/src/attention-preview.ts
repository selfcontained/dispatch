/** Longest preview kept; toasts and drawer cards clamp it visually. */
export const ATTENTION_PREVIEW_MAX = 500;

/**
 * The first non-empty line of a message, as the Markdown source a toast or
 * drawer card renders. The card's CSS line clamp does the visual shortening,
 * so this only bounds what's sent. A line over `max` is cut at a space where
 * no code span, bold, italic or link is open, so the cut never leaves a
 * dangling `**`, backtick or `[` that would render as literal text.
 */
export function attentionPreview(
  text: string,
  max: number = ATTENTION_PREVIEW_MAX
): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  if (line.length <= max) return line;

  let code = false;
  let bold = false;
  let italic = false;
  let linkDepth = 0;
  let inUrl = false;
  let safe = -1;
  for (let i = 0; i < max; i++) {
    const c = line[i];
    if (code) {
      if (c === "`") code = false;
      continue;
    }
    if (inUrl) {
      if (c === ")") inUrl = false;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") code = true;
    else if (c === "*" && line[i + 1] === "*") {
      bold = !bold;
      i++;
    } else if (c === "*") italic = !italic;
    else if (c === "[") linkDepth++;
    else if (c === "]") {
      if (linkDepth > 0) linkDepth--;
      if (line[i + 1] === "(") {
        inUrl = true;
        i++;
      }
    } else if (/\s/.test(c) && !bold && !italic && linkDepth === 0) {
      safe = i;
    }
  }
  if (safe > 0) return `${line.slice(0, safe).trimEnd()}…`;
  // No safe boundary (one long token or a span open from the start): drop the
  // markup characters so nothing renders as a stray symbol.
  return `${line.slice(0, max - 1).replace(/[`*[\]]/g, "")}…`;
}
