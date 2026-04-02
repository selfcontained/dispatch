import ReactMarkdown from "react-markdown";

import { cn } from "@/lib/utils";

export function Markdown({ children, className }: { children: string; className?: string }): JSX.Element {
  return (
    <div
      className={cn(
        "prose prose-sm prose-invert max-w-none",
        "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
        "prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-foreground",
        "prose-pre:bg-muted prose-pre:rounded-md prose-pre:p-2 prose-pre:text-xs",
        "prose-code:text-xs prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-primary prose-a:underline",
        "prose-strong:text-foreground",
        className,
      )}
    >
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
