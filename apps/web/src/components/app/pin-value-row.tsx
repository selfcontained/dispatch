import { Check, Copy, FileText, GitPullRequest } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import {
  resolveDisplayValue,
  shouldRenderMarkdownAsPlainText,
  trimFilenameForDisplay,
} from "@/components/app/pin-value-utils";
import { type AgentPin } from "@/components/app/types";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCopyText } from "@/hooks/use-copy";

export function CopyButton({
  value,
  title,
}: {
  value: string;
  title?: string;
}): JSX.Element {
  const [copied, copyText] = useCopyText();

  return (
    <button
      onClick={() => copyText(value)}
      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      title={title ?? "Copy to clipboard"}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

function MarkdownPinBody({ value }: { value: string }): JSX.Element {
  const renderAsPlainText = shouldRenderMarkdownAsPlainText(value);

  return (
    <ScrollArea
      className="min-w-0 max-h-48 rounded-md border border-border/60 bg-background/40"
      data-testid="markdown-pin-scroll"
      horizontal
    >
      <div className="p-2" data-testid="markdown-pin-body">
        {renderAsPlainText ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs text-foreground">
            {value}
          </pre>
        ) : (
          <Markdown variant="pin">{value}</Markdown>
        )}
      </div>
    </ScrollArea>
  );
}

/**
 * Shortcut pins are a button, not a value: `label` is the button text, `value`
 * is the prompt delivered to the owning agent on click, and `caption` is an
 * optional one-line caption for context a human wants before clicking. On a
 * `disabled` shortcut the same slot doubles as the reason it's unavailable
 * (e.g. "already building — agt_...") — there's no separate reason field.
 */
export function PinCaption({ value }: { value: string }): JSX.Element {
  return (
    <div className="mt-1" data-testid="pin-caption">
      <Markdown variant="caption">{value}</Markdown>
    </div>
  );
}

export function PinValueRow({
  type,
  value,
  workspaceRoot,
}: {
  type: AgentPin["type"];
  value: string;
  workspaceRoot: string | null;
}): JSX.Element {
  if (type === "markdown") {
    return <MarkdownPinBody value={value} />;
  }

  const filenameValue =
    type === "filename" ? trimFilenameForDisplay(value, workspaceRoot) : null;
  const { display, tooltip, href, badge, icon } = resolveDisplayValue(
    type,
    filenameValue?.display ?? value
  );
  const tooltipValue = filenameValue?.tooltip ?? tooltip;

  return (
    <div className="flex items-center gap-1.5">
      {icon === "pr" && (
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-primary" />
      )}
      {icon === "file" && (
        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-xs text-blue-400 hover:text-blue-300 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
          title={tooltip}
        >
          {display}
        </a>
      ) : badge ? (
        type === "filename" ? (
          <FrontTruncatedValue
            value={display}
            mono
            className="min-w-0 rounded bg-muted px-1.5 py-0.5"
            tooltipClassName="max-w-[480px]"
            tooltipValue={tooltipValue}
          />
        ) : (
          <span
            className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            title={tooltip}
          >
            {display}
          </span>
        )
      ) : (
        <ScrollArea className="min-w-0 max-h-32">
          {type === "string" ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs text-foreground">
              {display}
            </pre>
          ) : (
            <span className="break-words text-xs text-foreground">
              {display}
            </span>
          )}
        </ScrollArea>
      )}
    </div>
  );
}
