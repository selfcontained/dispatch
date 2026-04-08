import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

type MarkdownProps = {
  children: string;
  className?: string;
  variant?: "default" | "pin";
};

export function Markdown({ children, className, variant = "default" }: MarkdownProps): JSX.Element {
  if (variant === "pin") {
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
          className,
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={["p", "ul", "li", "strong", "em", "code", "pre", "table", "thead", "tbody", "tr", "th", "td"]} unwrapDisallowed>
          {children}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        // Use theme CSS variables for colors so it works across all themes
        "text-foreground prose-headings:text-foreground prose-strong:text-foreground",
        "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
        "prose-headings:mt-3 prose-headings:mb-1",
        "prose-pre:bg-muted prose-pre:rounded-md prose-pre:p-2 prose-pre:text-xs prose-pre:overflow-x-auto",
        "prose-code:text-xs prose-code:text-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-primary prose-a:underline",
        "prose-li:text-foreground prose-li:marker:text-muted-foreground",
        className,
      )}
    >
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
