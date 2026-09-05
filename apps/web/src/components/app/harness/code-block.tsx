import { useMemo, useState, type ReactNode } from "react";

import {
  highlightCodeLanguage,
  resolveHighlightLanguage,
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

/** Lines beyond this are hidden until the block is expanded. */
export const COLLAPSED_LINES = 24;

/**
 * Clips a long block to {@link COLLAPSED_LINES} rows with a "Show all"
 * control, so the conversation keeps the only vertical scrollbar. The
 * block never scrolls sideways: rows wrap.
 */
export function ExpandableBlock({
  lineCount,
  children,
  className,
  testId,
}: {
  lineCount: number;
  children: ReactNode;
  className?: string;
  testId?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const collapsible = lineCount > COLLAPSED_LINES;
  const clipped = collapsible && !expanded;
  return (
    <div
      className={cn("rounded-md bg-background/60", className)}
      data-testid={testId}
      data-expanded={collapsible ? String(expanded) : undefined}
    >
      <div
        className={cn("relative", clipped && "max-h-80 overflow-hidden")}
        style={
          clipped
            ? { maxHeight: `calc(${COLLAPSED_LINES} * 1.5 * 11px + 1rem)` }
            : undefined
        }
      >
        {children}
        {clipped ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/90 to-transparent"
          />
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="harness-block-toggle"
          className="w-full border-t border-border/40 px-2 py-1 text-left text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Collapse" : `Show all ${lineCount} lines`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Highlighted code with an optional line-number gutter. Each line is a
 * grid row — number cell, code cell — so long lines wrap under their own
 * number and nothing scrolls sideways. Lines are highlighted one at a
 * time; a construct that spans lines loses its colour past the first.
 */
export function CodeBlock({
  code,
  fileName,
  language,
  startLine,
  lineNumbers = startLine !== undefined,
}: {
  code: string;
  /** Picks the language by extension. */
  fileName?: string;
  /** Explicit language when there is no file name. */
  language?: string;
  startLine?: number;
  lineNumbers?: boolean;
}): JSX.Element {
  const lines = useMemo(() => {
    const raw = code === "" ? [] : code.split("\n");
    const lang = resolveHighlightLanguage({ fileName, language });
    return raw.map((line) =>
      lang
        ? (highlightCodeLanguage(line, lang) ?? escapeHtml(line))
        : escapeHtml(line)
    );
  }, [code, fileName, language]);
  const first = startLine ?? 1;
  return (
    <ExpandableBlock lineCount={lines.length} testId="harness-code">
      <div
        className={cn(
          "hljs grid !bg-transparent py-2 font-terminal text-[11px] leading-[1.5]",
          lineNumbers ? "grid-cols-[auto_1fr]" : "grid-cols-1"
        )}
      >
        {lines.map((html, i) => (
          <LineRow
            key={i}
            number={lineNumbers ? first + i : null}
            html={html}
          />
        ))}
      </div>
    </ExpandableBlock>
  );
}

function LineRow({
  number,
  html,
}: {
  number: number | null;
  html: string;
}): JSX.Element {
  return (
    <>
      {number !== null ? (
        <span
          aria-hidden="true"
          className="select-none pl-2 pr-3 text-right text-muted-foreground/60"
        >
          {number}
        </span>
      ) : null}
      <code
        className="min-w-0 whitespace-pre-wrap break-words pl-2 pr-2 [overflow-wrap:anywhere]"
        dangerouslySetInnerHTML={{ __html: html || " " }}
      />
    </>
  );
}

/** Pretty-printed, highlighted JSON. */
export function JsonBlock({ value }: { value: unknown }): JSX.Element {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return <CodeBlock code={text} language="json" />;
}

/** A list of paths: directory muted, file name bright. */
export function PathList({ text }: { text: string }): JSX.Element {
  const paths = text.split("\n").filter((l) => l.trim() !== "");
  return (
    <ExpandableBlock lineCount={paths.length} testId="harness-paths">
      <ul className="p-2 font-terminal text-[11px] leading-[1.5]">
        {paths.map((raw, i) => {
          const p = raw.trim();
          const idx = p.lastIndexOf("/");
          const dir = idx >= 0 ? p.slice(0, idx + 1) : "";
          const base = idx >= 0 ? p.slice(idx + 1) : p;
          return (
            <li
              key={`${p}:${i}`}
              className="break-all [overflow-wrap:anywhere]"
            >
              <span className="text-muted-foreground">{dir}</span>
              <span className="text-foreground">{base}</span>
            </li>
          );
        })}
      </ul>
    </ExpandableBlock>
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
  return <PlainBlock text={text} />;
}

/** Wrapped plain text, clipped past a screenful. */
export function PlainBlock({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  return (
    <ExpandableBlock
      lineCount={text.split("\n").length}
      className={className}
      testId="harness-plain"
    >
      <pre className="whitespace-pre-wrap break-words p-2 font-terminal text-[11px] leading-[1.5] [overflow-wrap:anywhere]">
        {text}
      </pre>
    </ExpandableBlock>
  );
}
