import { Check, Copy, ExternalLink, FileText, GitPullRequest, Pin } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { type AgentPin } from "@/components/app/types";
import { Markdown } from "@/components/ui/markdown";
import { useCopyText } from "@/hooks/use-copy";
import { splitPinValues } from "@/lib/pins";
import { ScrollArea } from "@/components/ui/scroll-area";

const SAFE_URL_RE = /^https?:\/\//i;
const GH_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i;

/** Turn a GitHub PR URL into "owner/repo#123"; fall back to the raw value. */
function formatPrDisplay(value: string): string {
  const m = GH_PR_RE.exec(value);
  return m ? `${m[1]}#${m[2]}` : value;
}

function CopyButton({ value, title }: { value: string; title?: string }): JSX.Element {
  const [copied, copyText] = useCopyText();

  return (
    <button
      onClick={() => copyText(value)}
      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      title={title ?? "Copy to clipboard"}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

type ResolvedValue = { display: string; tooltip: string; href: string | null; badge: boolean; icon: "pr" | "file" | null };

function trimFilenameForDisplay(value: string, workspaceRoot: string | null): { display: string; tooltip: string } {
  if (!workspaceRoot) {
    return { display: value, tooltip: value };
  }

  const normalizedRoot = workspaceRoot.endsWith("/") ? workspaceRoot.slice(0, -1) : workspaceRoot;
  if (!normalizedRoot) {
    return { display: value, tooltip: value };
  }

  if (value === normalizedRoot) {
    return { display: "./", tooltip: value };
  }

  const prefix = `${normalizedRoot}/`;
  return value.startsWith(prefix)
    ? { display: value.slice(prefix.length), tooltip: value }
    : { display: value, tooltip: value };
}

function shouldRenderMarkdownAsPlainText(value: string): boolean {
  const sanitized = value.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  const unsupportedPatterns = [
    /!\[[^\]]*]\((?:[^()\\]|\\.)+\)/,
    /\[[^\]]+]\((?:[^()\\]|\\.)+\)/,
    /\[[^\]]+]\[[^\]]*]/,
    /^\s*\[[^\]]+]:\s*\S+/m,
    /<\/?[A-Za-z][^>]*>/,
    /^\s{0,3}#{1,6}\s/m,
    /^\s{0,3}>\s/m,
    /^\s{0,3}\d+\.\s/m,
    /^(?: {2,}|\t+)[-*+]\s/m,
    /^(?: {2,}|\t+)\d+\.\s/m,
    /^\s*\|.+\|\s*$/m,
    /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/m,
  ];
  return unsupportedPatterns.some((pattern) => pattern.test(sanitized));
}

function MarkdownPinBody({ value }: { value: string }): JSX.Element {
  const renderAsPlainText = shouldRenderMarkdownAsPlainText(value);

  return (
    <div
      className="min-w-0 max-h-48 overflow-y-auto overflow-x-hidden rounded-md border border-border/60 bg-background/40"
      data-testid="markdown-pin-scroll"
    >
      <div className="p-2" data-testid="markdown-pin-body">
        {renderAsPlainText ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs text-foreground">
            {value}
          </pre>
        ) : (
          <Markdown variant="pin">
            {value}
          </Markdown>
        )}
      </div>
    </div>
  );
}

function resolveDisplayValue(type: AgentPin["type"], value: string): ResolvedValue {
  if (type === "pr" && SAFE_URL_RE.test(value)) {
    return { display: formatPrDisplay(value), tooltip: value, href: value, badge: false, icon: "pr" };
  }
  if (type === "pr") {
    return { display: value, tooltip: value, href: null, badge: false, icon: "pr" };
  }
  if (type === "url" && SAFE_URL_RE.test(value)) {
    return { display: value, tooltip: value, href: value, badge: false, icon: null };
  }
  if (type === "url") {
    return { display: value, tooltip: value, href: null, badge: false, icon: null };
  }
  if (type === "filename") {
    return { display: value, tooltip: value, href: null, badge: true, icon: "file" };
  }
  if (type === "port" || type === "code") {
    return { display: value, tooltip: value, href: null, badge: true, icon: null };
  }
  return { display: value, tooltip: value, href: null, badge: false, icon: null };
}

function PinValueRow({
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

  const filenameValue = type === "filename" ? trimFilenameForDisplay(value, workspaceRoot) : null;
  const { display, tooltip, href, badge, icon } = resolveDisplayValue(type, filenameValue?.display ?? value);
  const tooltipValue = filenameValue?.tooltip ?? tooltip;

  return (
    <div className="flex items-center gap-1.5">
      {icon === "pr" && <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-primary" />}
      {icon === "file" && <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />}
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
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title="Open in browser"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function PinItem({ pin, workspaceRoot }: { pin: AgentPin; workspaceRoot: string | null }): JSX.Element {
  const values = splitPinValues(pin.type, pin.value);
  const isMulti = values.length > 1;

  return (
    <div className="px-4 py-2.5 border-b border-border last:border-b-0" data-testid="pin-item" data-pin-label={pin.label}>
      <div className="flex items-center gap-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
          {pin.label}
        </div>
        <div className="ml-auto">
          <CopyButton value={pin.value} title={isMulti ? "Copy all" : "Copy to clipboard"} />
        </div>
      </div>
      <div className="flex flex-col gap-1 mt-1">
        {values.map((v, i) => (
          <PinValueRow key={i} type={pin.type} value={v} workspaceRoot={workspaceRoot} />
        ))}
      </div>
    </div>
  );
}

type PinsPanelProps = {
  pins: AgentPin[];
  selectedAgentName: string | null;
  selectedAgentWorkspaceRoot: string | null;
};

export function PinsPanel({ pins, selectedAgentName, selectedAgentWorkspaceRoot }: PinsPanelProps): JSX.Element {
  if (pins.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Pin className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">
            {selectedAgentName
              ? "No pins yet. Agents can pin URLs, files, ports, summaries, and other info here."
              : "Focus an agent to view pins."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
      {pins.map((pin) => (
        <PinItem key={pin.label.toLowerCase()} pin={pin} workspaceRoot={selectedAgentWorkspaceRoot} />
      ))}
    </div>
  );
}
