import ReactMarkdown from "react-markdown";

import { cn } from "@/lib/utils";

export function Markdown({ children, className }: { children: string; className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        // Use theme CSS variables for colors so it works across all themes
        "text-foreground prose-headings:text-foreground prose-strong:text-foreground",
        "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
        "prose-headings:mt-3 prose-headings:mb-1",
        "prose-pre:bg-muted prose-pre:rounded-md prose-pre:p-2 prose-pre:text-xs",
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
