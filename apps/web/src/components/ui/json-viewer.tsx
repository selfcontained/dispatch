import { useMemo } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCopyText } from "@/hooks/use-copy";

type JsonViewerProps = {
  value: unknown;
  maxHeight?: number;
  className?: string;
  collapsed?: boolean;
};

type Token = { text: string; className: string };

function tokenize(json: string): Token[] {
  const tokens: Token[] = [];
  const re =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])|(\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(json)) !== null) {
    if (match[1]) {
      if (match[2]) {
        tokens.push({ text: match[1], className: "text-sky-400" });
        tokens.push({ text: match[2], className: "text-muted-foreground" });
      } else {
        tokens.push({ text: match[1], className: "text-emerald-400" });
      }
    } else if (match[3]) {
      tokens.push({ text: match[3], className: "text-violet-400" });
    } else if (match[4]) {
      tokens.push({ text: match[4], className: "text-amber-400" });
    } else if (match[5]) {
      tokens.push({ text: match[5], className: "text-muted-foreground" });
    } else if (match[6]) {
      tokens.push({ text: match[6], className: "" });
    }
  }
  return tokens;
}

export function JsonViewer({
  value,
  maxHeight = 240,
  className,
  collapsed,
}: JsonViewerProps): JSX.Element {
  const raw = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const tokens = useMemo(() => tokenize(raw), [raw]);
  const [copied, copyText] = useCopyText();

  if (collapsed) {
    const oneLine = JSON.stringify(value);
    const preview = oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
    return (
      <code className="text-xs text-muted-foreground font-mono">{preview}</code>
    );
  }

  return (
    <div className={cn("group/json relative", className)}>
      <button
        type="button"
        onClick={() => copyText(raw)}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/80 p-1 opacity-0 transition-opacity group-hover/json:opacity-100"
        aria-label="Copy JSON"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      <pre
        className="overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed font-mono"
        style={{ maxHeight }}
      >
        <code>
          {tokens.map((t, i) => (
            <span key={i} className={t.className}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
