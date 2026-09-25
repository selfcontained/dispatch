import { Children, isValidElement, memo, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { highlightCodeLanguage } from "@/components/app/file-lightbox-syntax";
import { useCopyText } from "@/hooks/use-copy";
import { MermaidBlock } from "@/components/ui/markdown-mermaid";
import { useMermaidTheme } from "@/components/ui/markdown-mermaid-theme";
import { cn } from "@/lib/utils";
import { agentSwitchValidationMode } from "@/lib/agent-switch-validation";

// Highlight.js runs synchronously. Keep colors for long code blocks, but do
// not highlight the same cached chat message again on every agent switch.
const MAX_HIGHLIGHT_CACHE_CHARS = 8_000_000;
const highlightCache = new Map<string, string>();
let highlightCacheChars = 0;

function highlightMarkdownCode(code: string, language?: string): string | null {
  // The validation mode must reproduce the original uncached behavior.
  if (agentSwitchValidationMode === "before") {
    return highlightCodeLanguage(code, language);
  }

  const key = `${language ?? ""}\0${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;

  const html = highlightCodeLanguage(code, language);
  if (html === null) return null;
  const size = key.length + html.length;
  if (size <= MAX_HIGHLIGHT_CACHE_CHARS) {
    while (highlightCacheChars + size > MAX_HIGHLIGHT_CACHE_CHARS) {
      const oldest = highlightCache.keys().next().value;
      if (oldest === undefined) break;
      highlightCacheChars -= oldest.length + highlightCache.get(oldest)!.length;
      highlightCache.delete(oldest);
    }
    highlightCache.set(key, html);
    highlightCacheChars += size;
  }
  return html;
}

/**
 * A fenced code block with a copy button in its corner, like a post's own
 * copy action: the block is the thing worth lifting out of a message.
 */
function CodeBlock({
  code,
  children,
}: {
  code: string;
  children: ReactNode;
}): JSX.Element {
  const [copied, copyText] = useCopyText();
  return (
    <div className="group/code relative" data-testid="markdown-code-block">
      <pre>{children}</pre>
      <button
        type="button"
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100 [@media(pointer:coarse)]:opacity-100",
          copied && "text-status-working opacity-100"
        )}
        onClick={() => copyText(code)}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Code copied" : "Copy code"}
        data-testid="markdown-copy-code"
      >
        {copied ? (
          <Check className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function getCodeBlock(
  children: ReactNode
): { className?: string; code: string } | null {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (
    !child ||
    !isValidElement<{ className?: string; children?: ReactNode }>(child)
  ) {
    return null;
  }

  const code = child.props.children;
  if (typeof code !== "string") {
    return null;
  }

  return {
    className: child.props.className,
    code: code.replace(/\n$/, ""),
  };
}

type MarkdownProps = {
  children: string;
  className?: string;
  variant?: "default" | "pin" | "caption";
  // Colors h1/h2 for skimming a long document (see MarkdownDefault). Off by
  // default: most `default`-variant consumers are compact cards that pass
  // their own dimmed base color (e.g. text-muted-foreground, text-foreground/85)
  // and a full-opacity accent heading would fight that. Opt in for a
  // dedicated document-reading surface like the lightbox.
  headingAccents?: boolean;
};

export const Markdown = memo(function Markdown({
  children,
  className,
  variant = "default",
  headingAccents = false,
}: MarkdownProps): JSX.Element {
  if (variant === "pin") {
    return <MarkdownPin className={className}>{children}</MarkdownPin>;
  }

  if (variant === "caption") {
    return <MarkdownCaption className={className}>{children}</MarkdownCaption>;
  }

  return (
    <MarkdownDefault className={className} headingAccents={headingAccents}>
      {children}
    </MarkdownDefault>
  );
});

/**
 * Single-line muted markdown for subtitles (e.g. a shortcut pin's caption).
 * Inline marks only — block elements are unwrapped so the caption can never
 * grow into a second paragraph or a list.
 */
function MarkdownCaption({
  children,
  className,
}: Pick<MarkdownProps, "children" | "className">): JSX.Element {
  return (
    <span
      className={cn(
        // Hard clamp as a backstop to the server-side length cap: a caption is
        // a subtitle, never a paragraph. Three lines matches the budget
        // MAX_PIN_CAPTION_LENGTH is sized against, so a caption within the cap
        // is never silently cut.
        "line-clamp-3 text-[11px] leading-tight text-muted-foreground",
        "[&_strong]:font-semibold [&_strong]:text-foreground/80 [&_em]:italic",
        "[&_del]:line-through",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[10px]",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={["strong", "em", "code", "del"]}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </span>
  );
}

function MarkdownPin({
  children,
  className,
}: Pick<MarkdownProps, "children" | "className">): JSX.Element {
  return (
    <div
      className={cn(
        "max-w-none text-xs text-foreground",
        "[&_p]:my-1 [&_p]:[overflow-wrap:anywhere]",
        "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4",
        "[&_li]:my-0.5 [&_li]:[overflow-wrap:anywhere]",
        "[&_strong]:font-semibold [&_em]:italic",
        "[&_pre]:my-1 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:overflow-x-hidden [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:break-words [&_code]:whitespace-pre-wrap",
        "[&_table]:my-1 [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[11px]",
        "[&_th]:border [&_th]:border-border/60 [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={[
          "p",
          "ul",
          "li",
          "strong",
          "em",
          "code",
          "pre",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
        ]}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownDefault({
  children,
  className,
  headingAccents = false,
}: Pick<
  MarkdownProps,
  "children" | "className" | "headingAccents"
>): JSX.Element {
  const mermaidTheme = useMermaidTheme();

  return (
    <div
      className={cn(
        "prose prose-sm min-w-0 max-w-full",
        // Use theme CSS variables for colors so it works across all themes
        "text-foreground prose-headings:text-foreground prose-strong:text-foreground",
        "prose-p:my-1 prose-p:[overflow-wrap:anywhere] prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-li:[overflow-wrap:anywhere]",
        "prose-headings:mt-3 prose-headings:mb-1",
        // Color h1/h2 for skimming a long document — a file that's mostly
        // headings and short paragraphs needs more than a size bump,
        // especially at prose-sm sizes where h2/h3 are close together. Uses
        // dedicated --heading-accent-1/-2 tokens rather than --primary, so a
        // heading is never mistaken for a link at a glance. h3-h6 stay on
        // the prose-headings:text-foreground rule above — size and weight
        // carry those levels instead. `prose-h1:`/`prose-h2:` sort after
        // `prose-headings:` in the generated stylesheet regardless of
        // className order, so these win over the shared rule for just
        // those two levels.
        headingAccents && "prose-h1:text-heading-accent-1",
        headingAccents && "prose-h2:text-heading-accent-2",
        "prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-muted prose-pre:p-2 prose-pre:text-xs",
        "prose-code:text-xs prose-code:text-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:break-words prose-code:[overflow-wrap:anywhere]",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-primary prose-a:underline prose-a:[overflow-wrap:anywhere]",
        "prose-li:text-foreground prose-li:marker:text-muted-foreground",
        // Typography's default blockquote/hr/table colors are a fixed
        // light-mode gray scale (e.g. text-gray-900 quotes), which reads as
        // near-invisible against a dark theme's background. Route them
        // through the same theme variables as everything else above.
        "prose-blockquote:text-muted-foreground prose-blockquote:border-border",
        "prose-hr:border-border",
        // Typography borders thead/tbody-tr, not th/td directly — a
        // prose-th:/prose-td:border-border override is a silent no-op
        // (no border-width to color). prose-thead: covers the header rule,
        // prose-tr: covers per-row dividers.
        "prose-th:text-foreground",
        "prose-thead:border-border",
        "prose-tr:border-border",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table({ node: _node, ...props }) {
            return (
              <div
                className="max-w-full overflow-x-auto"
                data-testid="markdown-table-scroll"
              >
                <table {...props} />
              </div>
            );
          },
          pre({ children }) {
            const block = getCodeBlock(children);
            if (block?.className === "language-mermaid") {
              return <MermaidBlock code={block.code} theme={mermaidTheme} />;
            }
            const highlightedHtml = block
              ? highlightMarkdownCode(block.code, block.className)
              : null;
            if (block && highlightedHtml) {
              return (
                <CodeBlock code={block.code}>
                  <code
                    className={cn(block.className, "hljs")}
                    dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                  />
                </CodeBlock>
              );
            }
            return block ? (
              <CodeBlock code={block.code}>{children}</CodeBlock>
            ) : (
              <pre>{children}</pre>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
