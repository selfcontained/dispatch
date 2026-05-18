import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  CheckCircle2,
  Copy,
  MessageCircleQuestion,
  RotateCcw,
  Wrench,
} from "lucide-react";

import { type Agent, type FeedbackItem } from "@/components/app/types";
import { canCancelRecheck } from "@/components/app/feedback-utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function StatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}): JSX.Element | null {
  if (status === "fixed") {
    return <CheckCircle2 className={cn("h-3.5 w-3.5", className)} />;
  }
  if (status === "ignored") {
    return <Ban className={cn("h-3.5 w-3.5", className)} />;
  }
  return null;
}

export function RoundChip({
  roundNumber,
  pending = false,
}: {
  roundNumber: number;
  pending?: boolean;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
        pending
          ? "border-status-reviewing/35 bg-status-reviewing/10 text-status-reviewing"
          : roundNumber >= 2
            ? "border-orange-500/30 bg-orange-500/10 text-orange-500"
            : "border-border bg-muted/50 text-muted-foreground"
      )}
    >
      {pending ? "R2 pending" : `R${roundNumber}`}
    </span>
  );
}

export function FeedbackItemNotFoundState({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <div
      data-testid="feedback-item-not-found"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center",
        className
      )}
    >
      <div className="max-w-sm space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Feedback item not found</p>
        <p>
          The URL points to a feedback item that is no longer available for this
          review agent.
        </p>
      </div>
    </div>
  );
}

export function FeedbackActions({
  isConnected,
  onForward,
  onCopy,
  copied,
  onUpdateStatus,
  isActionable,
  statusLabel,
  size = "sm",
}: {
  isConnected: boolean;
  onForward: (mode: "wdyt" | "fix") => void;
  onCopy: () => void;
  copied: boolean;
  onUpdateStatus: (status: string) => void;
  isActionable: boolean;
  statusLabel: { label: string; color: string } | undefined;
  size?: "sm" | "default";
}): JSX.Element {
  const btnClass =
    size === "sm"
      ? "h-6 gap-1 px-1.5 text-[10px]"
      : "h-7 gap-1.5 px-2.5 text-xs";
  const iconClass = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const resolveIconClass = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const resolveBtnClass =
    size === "sm" ? "h-6 px-1.5 text-[10px]" : "h-7 px-2 text-xs gap-1.5";

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        {isActionable ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(!isConnected && "cursor-not-allowed")}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      btnClass,
                      !isConnected && "opacity-40 pointer-events-none"
                    )}
                    onClick={() => onForward("wdyt")}
                  >
                    <MessageCircleQuestion className={iconClass} /> WDYT
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isConnected
                  ? "Ask what it thinks about this"
                  : "Connect to parent agent to forward feedback"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(!isConnected && "cursor-not-allowed")}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      btnClass,
                      !isConnected && "opacity-40 pointer-events-none"
                    )}
                    onClick={() => onForward("fix")}
                  >
                    <Wrench className={iconClass} /> Fix
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isConnected
                  ? "Tell agent to fix this"
                  : "Connect to parent agent to forward feedback"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={btnClass}
                onClick={onCopy}
              >
                {copied ? (
                  <Check className={iconClass + " text-green-500"} />
                ) : (
                  <Copy className={iconClass} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy to clipboard</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex items-center gap-1">
        {isActionable ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    resolveBtnClass + " text-green-500/70 hover:text-green-500"
                  }
                  onClick={() => onUpdateStatus("fixed")}
                >
                  <CheckCircle2 className={resolveIconClass} />
                  {size === "default" ? "Fixed" : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mark as fixed</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    resolveBtnClass +
                    " text-muted-foreground/50 hover:text-muted-foreground"
                  }
                  onClick={() => onUpdateStatus("ignored")}
                >
                  <Ban className={resolveIconClass} />
                  {size === "default" ? "Ignore" : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Ignore this finding</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <div className="flex items-center gap-1">
            {statusLabel ? (
              <span
                className={cn(
                  "text-[10px]",
                  size === "default" && "text-sm",
                  statusLabel.color
                )}
              >
                {statusLabel.label}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className={btnClass}
              onClick={() => onUpdateStatus("open")}
            >
              <RotateCcw className={iconClass} /> Reopen
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ResolutionInfoBlock({
  item,
  className,
}: {
  item: FeedbackItem;
  className?: string;
}): JSX.Element | null {
  const sha = item.resolutionCommit?.slice(0, 7);
  if (!item.resolutionReason && !sha) return null;
  return (
    <div className={cn("space-y-1", className)}>
      {item.resolutionReason ? (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
            Resolution reason
          </div>
          <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
            {item.resolutionReason}
          </div>
        </div>
      ) : null}
      {sha ? (
        <div className="text-[10px] text-muted-foreground/70">
          Resolved at commit{" "}
          <span className="font-mono text-muted-foreground">{sha}</span>
        </div>
      ) : null}
    </div>
  );
}

export function CancelRecheckButton({
  parentAgentId,
  agent,
  onDone,
}: {
  parentAgentId: string;
  agent: Agent;
  onDone?: () => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canCancelRecheck(agent)) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error ? (
        <div
          className="text-[11px] text-status-blocked"
          data-testid="cancel-recheck-error"
        >
          {error}
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground/80 hover:text-foreground"
        disabled={isCancelling}
        onClick={() => {
          const confirmed = window.confirm(
            "Cancel the recheck and let this reviewer exit?"
          );
          if (!confirmed) return;
          setIsCancelling(true);
          setError(null);
          void api(
            `/api/v1/agents/${parentAgentId}/persona-reviews/${agent.id}/cancel-recheck`,
            { method: "POST" }
          )
            .then(async () => {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["agents"] }),
                queryClient.invalidateQueries({
                  queryKey: ["feedback", parentAgentId, "children"],
                }),
              ]);
              onDone?.();
            })
            .catch((err: Error) => {
              setError(err.message || "Could not cancel recheck.");
            })
            .finally(() => {
              setIsCancelling(false);
            });
        }}
        data-testid="cancel-recheck-button"
      >
        {isCancelling ? "Cancelling..." : "Cancel recheck"}
      </Button>
    </div>
  );
}

export function IgnoreReasonInput({
  onCancel,
  onSubmit,
  size = "default",
}: {
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  size?: "sm" | "default";
}): JSX.Element {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;
  const submit = () => {
    if (canSubmit) onSubmit(trimmed);
  };
  const inputClass =
    size === "sm" ? "h-7 px-2 text-[11px]" : "h-11 px-3 text-sm";
  const btnClass = size === "sm" ? "h-7 px-2 text-[11px]" : "h-11 px-3 text-sm";
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border border-border bg-background/60 p-1"
      )}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Why ignore? (required)"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground/60 outline-none",
          inputClass
        )}
      />
      <Button
        variant="ghost"
        size="sm"
        className={btnClass + " text-muted-foreground/60 hover:text-foreground"}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        variant="default"
        size="sm"
        className={btnClass}
        disabled={!canSubmit}
        onClick={submit}
      >
        Ignore
      </Button>
    </div>
  );
}
