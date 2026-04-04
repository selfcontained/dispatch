import { Check, Copy, ExternalLink, FileText, GitPullRequest } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { type AgentPin } from "@/components/app/types";

const SAFE_URL_RE = /^https?:\/\//i;
const GH_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i;

/** Types that support comma/newline-delimited multi-value. */
const MULTI_VALUE_TYPES = new Set<AgentPin["type"]>(["string", "url", "port", "filename"]);

/** Split a pin value into individual items if the type supports it. */
function splitValues(pin: AgentPin): string[] {
  if (!MULTI_VALUE_TYPES.has(pin.type)) return [pin.value];
  const parts = pin.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [pin.value];
}

/** Turn a GitHub PR URL into "owner/repo#123"; fall back to the raw value. */
function formatPrDisplay(value: string): string {
  const m = GH_PR_RE.exec(value);
  return m ? `${m[1]}#${m[2]}` : value;
}

function CopyButton({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [value]);

  return (
    <button
      onClick={handleCopy}
      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

type ResolvedValue = { display: string; tooltip: string; href: string | null; badge: boolean; icon: "pr" | "file" | null };

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

function PinValueRow({ type, value }: { type: AgentPin["type"]; value: string }): JSX.Element {
  const { display, tooltip, href, badge, icon } = resolveDisplayValue(type, value);

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
        <span
          className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
          title={tooltip}
        >
          {display}
        </span>
      ) : (
        <span
          className="min-w-0 truncate text-xs text-foreground"
          title={tooltip}
        >
          {display}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            title="Open in browser"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function PinItem({ pin }: { pin: AgentPin }): JSX.Element {
  const values = splitValues(pin);

  return (
    <div className="px-4 py-2.5 border-b border-border last:border-b-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
        {pin.label}
      </div>
      <div className="flex flex-col gap-1">
        {values.map((v, i) => (
          <PinValueRow key={i} type={pin.type} value={v} />
        ))}
      </div>
    </div>
  );
}

type PinsPanelProps = {
  pins: AgentPin[];
  selectedAgentName: string | null;
};

export function PinsPanel({ pins, selectedAgentName }: PinsPanelProps): JSX.Element {
  if (pins.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        {selectedAgentName
          ? "No pins yet. Agents can pin URLs, ports, and other info here."
          : "Focus an agent to view pins."}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
      {pins.map((pin) => (
        <PinItem key={pin.label.toLowerCase()} pin={pin} />
      ))}
    </div>
  );
}
