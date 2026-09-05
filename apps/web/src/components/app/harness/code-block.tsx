import { useMemo } from "react";

import {
  highlightCode,
  highlightCodeLanguage,
} from "@/components/app/media-lightbox-syntax";
import { cn } from "@/lib/utils";

/** dsh's read tool: <path>…</path>\n<type>file</type>\n<content>\n1: …</content>. */
export function parseReadOutput(output: string): {
  path?: string;
  type?: string;
  startLine?: number;
  code: string;
  /** Trailing unnumbered text, e.g. "(Showing lines 1-120 of 281 …)". */
  note?: string;
} {
  const path = /^<path>([^<]*)<\/path>/.exec(output)?.[1];
  const type = /<type>([^<]*)<\/type>/.exec(output)?.[1];
  const content = /<content>\n?([\s\S]*?)(?:<\/content>\s*)?$/.exec(output);
  const body = content ? content[1] : output;
  const lines = body.replace(/\n$/, "").split("\n");
  // "12: text" prefixes: strip them into a gutter. Lines after the last
  // numbered one (dsh's paging note) become a footnote.
  const numbered = lines.map((line) => /^(\d+): ?(.*)$/.exec(line));
  let last = -1;
  numbered.forEach((m, i) => {
    if (m) last = i;
  });
  const consistent =
    last >= 0 &&
    numbered
      .slice(0, last + 1)
      .every((m, i) => m !== null || lines[i].trim() === "");
  if (consistent) {
    const first = numbered.find((m) => m !== null);
    const note = lines
      .slice(last + 1)
      .join("\n")
      .trim();
    return {
      ...(path ? { path } : {}),
      ...(type ? { type } : {}),
      startLine: first ? Number(first[1]) : 1,
      code: numbered
        .slice(0, last + 1)
        .map((m, i) => (m ? m[2] : lines[i]))
        .join("\n"),
      ...(note ? { note } : {}),
    };
  }
  return { ...(path ? { path } : {}), ...(type ? { type } : {}), code: body };
}

/** A JSON object or array, parsed; null for anything else. */
export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** Every non-empty line is a path: no spaces, and a slash or an extension. */
export function looksLikePathList(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return (
    lines.length > 0 &&
    lines.every((l) => !/\s/.test(l.trim()) && /[/.]/.test(l.trim()))
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Highlighted code with an optional line-number gutter. The gutter is its
 * own column and the code never wraps, so highlight spans that cross lines
 * stay intact and the numbers stay aligned.
 */
export function CodeBlock({
  code,
  fileName,
  language,
  startLine,
  lineNumbers = startLine !== undefined,
  maxHeight = "max-h-80",
}: {
  code: string;
  /** Picks the language by extension. */
  fileName?: string;
  /** Explicit language when there is no file name. */
  language?: string;
  startLine?: number;
  lineNumbers?: boolean;
  maxHeight?: string;
}): JSX.Element {
  const html = useMemo(() => {
    const highlighted = fileName
      ? highlightCode(code, fileName)
      : language
        ? highlightCodeLanguage(code, language)
        : null;
    return highlighted ?? escapeHtml(code);
  }, [code, fileName, language]);
  const count = code === "" ? 0 : code.split("\n").length;
  const first = startLine ?? 1;
  return (
    <div
      className={cn(
        "flex overflow-auto rounded-md bg-background/60 font-terminal text-[11px] leading-[1.5]",
        maxHeight
      )}
      data-testid="harness-code"
    >
      {lineNumbers && count > 0 ? (
        <pre
          aria-hidden="true"
          className="sticky left-0 shrink-0 select-none border-r border-border/40 bg-background/60 py-2 pl-2 pr-2 text-right text-muted-foreground/60"
        >
          {Array.from({ length: count }, (_, i) => first + i).join("\n")}
        </pre>
      ) : null}
      <pre className="hljs min-w-0 flex-1 !bg-transparent p-2">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/** Pretty-printed, highlighted JSON. */
export function JsonBlock({
  value,
  maxHeight,
}: {
  value: unknown;
  maxHeight?: string;
}): JSX.Element {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return <CodeBlock code={text} language="json" maxHeight={maxHeight} />;
}

/** A list of paths: directory muted, file name bright. */
export function PathList({ text }: { text: string }): JSX.Element {
  const paths = text.split("\n").filter((l) => l.trim() !== "");
  return (
    <ul
      className="max-h-80 overflow-auto rounded-md bg-background/60 p-2 font-terminal text-[11px] leading-[1.5]"
      data-testid="harness-paths"
    >
      {paths.map((raw, i) => {
        const p = raw.trim();
        const idx = p.lastIndexOf("/");
        const dir = idx >= 0 ? p.slice(0, idx + 1) : "";
        const base = idx >= 0 ? p.slice(idx + 1) : p;
        return (
          <li key={`${p}:${i}`} className="whitespace-nowrap">
            <span className="text-muted-foreground">{dir}</span>
            <span className="text-foreground">{base}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Plain output, wrapped, for text that is neither code nor a list. */
export function OutputBlock({
  text,
}: {
  text: string | null | undefined;
}): JSX.Element | null {
  if (!text?.trim()) return null;
  const json = tryParseJson(text);
  if (json !== null) return <JsonBlock value={json} />;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-terminal text-[11px] leading-[1.5]">
      {text}
    </pre>
  );
}
