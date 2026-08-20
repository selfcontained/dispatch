import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { highlightCodeLanguage } from "@/components/app/media-lightbox-syntax";
import { MermaidBlock } from "@/components/ui/markdown-mermaid";
import { useMermaidTheme } from "@/components/ui/markdown-mermaid-theme";
import { cn } from "@/lib/utils";

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
};

export function Markdown({
  children,
  className,
  variant = "default",
}: MarkdownProps): JSX.Element {
  if (variant === "pin") {
    return <MarkdownPin className={className}>{children}</MarkdownPin>;
  }

  if (variant === "caption") {
    return <MarkdownCaption className={className}>{children}</MarkdownCaption>;
  }

  return <MarkdownDefault className={className}>{children}</MarkdownDefault>;
}

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
}: Pick<MarkdownProps, "children" | "className">): JSX.Element {
  const mermaidTheme = useMermaidTheme();

  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        // Use theme CSS variables for colors so it works across all themes
        "text-foreground prose-headings:text-foreground prose-strong:text-foreground",
        "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
        "prose-headings:mt-3 prose-headings:mb-1",
        "prose-pre:bg-muted prose-pre:rounded-md prose-pre:p-2 prose-pre:text-xs prose-pre:overflow-x-auto",
        "prose-code:text-xs prose-code:text-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:break-words prose-code:[overflow-wrap:anywhere]",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-primary prose-a:underline",
        "prose-li:text-foreground prose-li:marker:text-muted-foreground",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const block = getCodeBlock(children);
            if (block?.className === "language-mermaid") {
              return <MermaidBlock code={block.code} theme={mermaidTheme} />;
            }
            const highlightedHtml = block
              ? highlightCodeLanguage(block.code, block.className)
              : null;
            if (block && highlightedHtml) {
              return (
                <pre>
                  <code
                    className={cn(block.className, "hljs")}
                    dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                  />
                </pre>
              );
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
