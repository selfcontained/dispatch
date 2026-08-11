import {
  Check,
  CornerDownLeft,
  Copy,
  FileText,
  GitPullRequest,
  Pin,
} from "lucide-react";
import { useState } from "react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { resolvePinShortcutIcon } from "@/lib/pin-shortcut-icons";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { useCopyText } from "@/hooks/use-copy";
import { splitPinValues } from "@/lib/pins";
import { rewritePinUrl } from "@/lib/rewrite-pin-url";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const SAFE_URL_RE = /^https?:\/\//i;
const GH_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i;

/** Turn a GitHub PR URL into "owner/repo#123"; fall back to the raw value. */
function formatPrDisplay(value: string): string {
  const m = GH_PR_RE.exec(value);
  return m ? `${m[1]}#${m[2]}` : value;
}

function CopyButton({
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

type ResolvedValue = {
  display: string;
  tooltip: string;
  href: string | null;
  badge: boolean;
  icon: "pr" | "file" | null;
};

function trimFilenameForDisplay(
  value: string,
  workspaceRoot: string | null
): { display: string; tooltip: string } {
  if (!workspaceRoot) {
    return { display: value, tooltip: value };
  }

  const normalizedRoot = workspaceRoot.endsWith("/")
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;
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
  ];
  return unsupportedPatterns.some((pattern) => pattern.test(sanitized));
}

function normalizeExternalHref(
  type: AgentPin["type"],
  value: string
): string | null {
  if (type !== "url" && type !== "pr") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidate = SAFE_URL_RE.test(trimmed)
    ? trimmed
    : type === "url"
      ? `http://${trimmed}`
      : trimmed;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
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

function resolveDisplayValue(
  type: AgentPin["type"],
  value: string
): ResolvedValue {
  const href = normalizeExternalHref(type, value);
  if (type === "pr" && href) {
    return {
      display: formatPrDisplay(href),
      tooltip: value.trim(),
      href,
      badge: false,
      icon: "pr",
    };
  }
  if (type === "pr") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: false,
      icon: "pr",
    };
  }
  if (type === "url" && href) {
    return {
      display: value.trim(),
      tooltip: value.trim(),
      href,
      badge: false,
      icon: null,
    };
  }
  if (type === "url") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: false,
      icon: null,
    };
  }
  if (type === "filename") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: true,
      icon: "file",
    };
  }
  if (type === "port" || type === "code") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: true,
      icon: null,
    };
  }
  return {
    display: value,
    tooltip: value,
    href: null,
    badge: false,
    icon: null,
  };
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

/**
 * Shortcut pins are a button, not a value: `label` is the button text, `value`
 * is the prompt delivered to the owning agent on click, and `caption` is an
 * optional one-line caption for context a human wants before clicking.
 */
function PinCaption({ value }: { value: string }): JSX.Element {
  return (
    <div className="mt-2" title={value} data-testid="pin-caption">
      <Markdown variant="caption">{value}</Markdown>
    </div>
  );
}

function ShortcutPinItem({
  pin,
  disabled,
  onRun,
  inGroup,
  agentName,
}: {
  pin: AgentPin;
  disabled: boolean;
  onRun: () => void;
  inGroup: boolean;
  agentName: string | null;
}): JSX.Element {
  const Icon = resolvePinShortcutIcon(pin.icon);

  return (
    <div
      className={cn(
        inGroup
          ? "py-1 first:pt-0 last:pb-0"
          : "px-4 py-2.5 border-b border-border last:border-b-0"
      )}
      data-testid="pin-item"
      data-pin-label={pin.label}
      data-pin-type="shortcut"
    >
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button emits no pointer events, so the tooltip needs
                a live wrapper to hang off when the agent isn't running. */}
            <span className="block">
              <Button
                variant={pin.variant ?? "default"}
                size="sm"
                className="relative w-full gap-1.5 pl-2 pr-7"
                disabled={disabled}
                onClick={onRun}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="min-w-0 truncate">{pin.label}</span>
                {/* Constant send glyph: every shortcut pin delivers a prompt,
                    whatever icon the agent chose for it. */}
                <CornerDownLeft
                  className="absolute right-2 h-3 w-3 shrink-0 opacity-50"
                  aria-hidden
                />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            className="max-w-[320px] border-white/[0.18] bg-[hsl(var(--popover))] p-0"
          >
            {disabled ? (
              <p className="m-0 px-2.5 py-2 text-xs text-muted-foreground">
                {agentName ?? "This agent"} has no active session — shortcuts
                are unavailable.
              </p>
            ) : (
              <div className="flex flex-col">
                <div className="px-2.5 pb-1.5 pt-2">
                  <div className="truncate font-mono text-xs font-semibold text-primary">
                    {agentName ?? "this agent"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    will receive the following:
                  </div>
                </div>
                {/* The prompt reads as a quoted payload, not prose — same
                    monospace treatment the terminal will show it in. */}
                <pre className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-t border-white/[0.10] bg-[hsl(var(--background))] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                  {pin.value}
                </pre>
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {pin.caption ? <PinCaption value={pin.caption} /> : null}
    </div>
  );
}

/**
 * Lays pins out into render order, collapsing every pin that shares a `group`
 * name into a single block. The group is anchored where its *first* member
 * sits, so a later member being re-pinned can never relocate the block.
 */
type PinRow =
  | { kind: "pin"; pin: AgentPin }
  | { kind: "group"; name: string; pins: AgentPin[] };

export function layoutPins(pins: AgentPin[]): PinRow[] {
  const rows: PinRow[] = [];
  const groupRows = new Map<string, Extract<PinRow, { kind: "group" }>>();

  for (const pin of pins) {
    const name = pin.group?.trim();
    if (!name) {
      rows.push({ kind: "pin", pin });
      continue;
    }

    const key = name.toLowerCase();
    const existing = groupRows.get(key);
    if (existing) {
      existing.pins.push(pin);
      continue;
    }

    const row = { kind: "group" as const, name, pins: [pin] };
    groupRows.set(key, row);
    rows.push(row);
  }

  return rows;
}

export function PinItem({
  pin,
  workspaceRoot,
  agentIsRunning = true,
  onRunShortcut,
  inGroup = false,
  agentName = null,
}: {
  pin: AgentPin;
  workspaceRoot: string | null;
  agentIsRunning?: boolean;
  onRunShortcut?: (pin: AgentPin) => void;
  inGroup?: boolean;
  agentName?: string | null;
}): JSX.Element {
  if (pin.type === "shortcut") {
    return (
      <ShortcutPinItem
        pin={pin}
        disabled={!agentIsRunning || !onRunShortcut}
        onRun={() => onRunShortcut?.(pin)}
        inGroup={inGroup}
        agentName={agentName}
      />
    );
  }

  const effectiveValue =
    pin.type === "url"
      ? rewritePinUrl(pin.value, window.location.host)
      : pin.value;
  const values = splitPinValues(pin.type, effectiveValue);
  const isMulti = values.length > 1;

  return (
    <div
      className={cn(
        inGroup
          ? "py-1.5 first:pt-0 last:pb-0"
          : "px-4 py-2.5 border-b border-border last:border-b-0"
      )}
      data-testid="pin-item"
      data-pin-label={pin.label}
    >
      <div className="flex items-center gap-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
          {pin.label}
        </div>
        <div className="ml-auto">
          <CopyButton
            value={effectiveValue}
            title={isMulti ? "Copy all" : "Copy to clipboard"}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1 mt-1">
        {values.map((v, i) => (
          <PinValueRow
            key={i}
            type={pin.type}
            value={v}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
      {pin.caption ? <PinCaption value={pin.caption} /> : null}
    </div>
  );
}

type PinsPanelProps = {
  pins: AgentPin[];
  selectedAgentName: string | null;
  selectedAgentWorkspaceRoot: string | null;
  agentIsRunning?: boolean;
  onRunShortcut?: (pin: AgentPin) => void;
};

/**
 * Confirmation is opt-in per shortcut pin (`confirm: true`) — the owning agent
 * decides which of its own actions deserve a second look before firing.
 */
function ConfirmShortcutDialog({
  pin,
  onOpenChange,
  onConfirm,
}: {
  pin: AgentPin | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={pin !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="pin-shortcut-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{pin?.label ?? "Run action"}?</DialogTitle>
          <DialogDescription>
            This sends the following prompt to the agent:
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/40 p-2 font-sans text-xs text-foreground">
          {pin?.value}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={pin?.variant === "destructive" ? "destructive" : "primary"}
            onClick={onConfirm}
            data-testid="pin-shortcut-confirm"
          >
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PinsPanel({
  pins,
  selectedAgentName,
  selectedAgentWorkspaceRoot,
  agentIsRunning,
  onRunShortcut,
}: PinsPanelProps): JSX.Element {
  const [pendingShortcutPin, setPendingActionPin] = useState<AgentPin | null>(
    null
  );

  const handleRunShortcut = (pin: AgentPin): void => {
    if (pin.confirm) {
      setPendingActionPin(pin);
      return;
    }
    onRunShortcut?.(pin);
  };

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
    <div
      data-testid="pins-panel-scroll"
      className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
    >
      {layoutPins(pins).map((row) =>
        row.kind === "pin" ? (
          <PinItem
            key={row.pin.label.toLowerCase()}
            pin={row.pin}
            workspaceRoot={selectedAgentWorkspaceRoot}
            agentIsRunning={agentIsRunning}
            onRunShortcut={onRunShortcut ? handleRunShortcut : undefined}
            agentName={selectedAgentName}
          />
        ) : (
          <div
            key={`group:${row.name.toLowerCase()}`}
            className="px-4 py-2.5 border-b border-border last:border-b-0"
            data-testid="pin-group"
            data-pin-group={row.name}
          >
            <div className="text-[11px] font-medium leading-snug text-muted-foreground">
              {row.name}
            </div>
            <div className="mt-1.5 flex flex-col">
              {row.pins.map((pin) => (
                <PinItem
                  key={pin.label.toLowerCase()}
                  pin={pin}
                  workspaceRoot={selectedAgentWorkspaceRoot}
                  agentIsRunning={agentIsRunning}
                  onRunShortcut={onRunShortcut ? handleRunShortcut : undefined}
                  inGroup
                  agentName={selectedAgentName}
                />
              ))}
            </div>
          </div>
        )
      )}
      <ConfirmShortcutDialog
        pin={pendingShortcutPin}
        onOpenChange={(open) => {
          if (!open) setPendingActionPin(null);
        }}
        onConfirm={() => {
          if (pendingShortcutPin) onRunShortcut?.(pendingShortcutPin);
          setPendingActionPin(null);
        }}
      />
    </div>
  );
}
