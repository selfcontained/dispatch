import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { type AgentPin } from "@/components/app/types";

const SAFE_URL_RE = /^https?:\/\//i;

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

function resolveDisplayValue(pin: AgentPin): { display: string; href: string | null; badge: boolean } {
  if (pin.type === "url" && SAFE_URL_RE.test(pin.value)) {
    return { display: pin.value, href: pin.value, badge: false };
  }
  if (pin.type === "url") {
    // Unsafe scheme (e.g. javascript:) — render as plain text, not a link
    return { display: pin.value, href: null, badge: false };
  }
  if (pin.type === "port" || pin.type === "code") {
    return { display: pin.value, href: null, badge: true };
  }
  return { display: pin.value, href: null, badge: false };
}

function PinItem({ pin }: { pin: AgentPin }): JSX.Element {
  const { display, href, badge } = resolveDisplayValue(pin);

  return (
    <div className="px-4 py-2.5 border-b border-border last:border-b-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
        {pin.label}
      </div>
      <div className="flex items-center gap-1.5">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-xs text-blue-400 hover:text-blue-300 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
            title={display}
          >
            {display}
          </a>
        ) : badge ? (
          <span
            className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            title={display}
          >
            {display}
          </span>
        ) : (
          <span
            className="min-w-0 truncate text-xs text-foreground"
            title={display}
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
          <CopyButton value={pin.value} />
        </div>
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
