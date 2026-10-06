import hljs from "highlight.js/lib/core";
import { resolveHighlightLanguage } from "./file-lightbox-syntax";

export type FilesHighlight = {
  language: string | null;
  lines: string[] | null;
};

/** Balance highlight.js spans at line boundaries without losing multiline
 * grammar context. Input is escaped HTML produced by highlight.js, never raw
 * source. This lets the viewer mount only the current page of lines. */
export function splitHighlightedLines(html: string): string[] {
  const stack: string[] = [];
  const lines: string[] = [];
  let line = "";
  for (const part of html.split(/(<span\b[^>]*>|<\/span>|\n)/g)) {
    if (part === "\n") {
      lines.push(line + "</span>".repeat(stack.length));
      line = stack.join("");
    } else {
      if (part.startsWith("<span")) stack.push(part);
      else if (part === "</span>") stack.pop();
      line += part;
    }
  }
  lines.push(line + "</span>".repeat(stack.length));
  return lines;
}

/** Only called in a disposable worker in the app. Never auto-detect languages
 * across all grammars or spend unbounded time on minified/generated files. */
export function highlightFile(text: string, fileName: string): FilesHighlight {
  const language = resolveHighlightLanguage({ fileName });
  if (
    !language ||
    text.length > 262_144 ||
    text.split("\n").some((line) => line.length > 4000)
  ) {
    return { language: null, lines: null };
  }
  try {
    const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    if (html.length > 2_097_152) return { language: null, lines: null };
    const lines = splitHighlightedLines(html);
    return { language, lines };
  } catch {
    return { language: null, lines: null };
  }
}
