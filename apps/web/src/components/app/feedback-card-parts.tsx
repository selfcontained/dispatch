import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCircle2,
  Loader2,
  MessageCircle,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type FeedbackState = "open" | "fixed" | "dismissed";

// "inline" renders inside the wide diff view (right-aligned, width-capped
// controls); "sidebar" renders in the narrow reviews sidebar (full-width).
export type FeedbackCardVariant = "inline" | "sidebar";

const ACTION_ROW_CLASSES: Record<FeedbackCardVariant, string> = {
  inline: "ml-auto grid w-full max-w-sm grid-cols-2 gap-2",
  sidebar: "grid grid-cols-2 gap-2",
};

export function FeedbackReplyForm({
  replying,
  reply,
  isPending,
  variant,
  onReplyChange,
  onStartReply,
  onCancelReply,
  onSubmit,
}: {
  replying: boolean;
  reply: string;
  isPending: boolean;
  variant: FeedbackCardVariant;
  onReplyChange: (value: string) => void;
  onStartReply: () => void;
  onCancelReply: () => void;
  onSubmit: (event: React.FormEvent) => void;
}): JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {replying ? (
        <motion.form
          key="reply-form"
          initial={{ height: 0, marginTop: 0, opacity: 0 }}
          animate={{ height: "auto", marginTop: 12, opacity: 1 }}
          exit={{ height: 0, marginTop: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeInOut" }}
          className="-mx-0.5 space-y-2 overflow-hidden p-0.5"
          onSubmit={onSubmit}
        >
          <Textarea
            aria-label="Reply to feedback"
            className="min-h-0 h-16 resize-none px-2 py-1.5 text-xs"
            placeholder="Reply to agent…"
            value={reply}
            onChange={(event) => onReplyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelReply();
              }
            }}
            disabled={isPending}
            autoFocus
          />
          <div className={ACTION_ROW_CLASSES[variant]}>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="w-full"
              onClick={onCancelReply}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              className="w-full"
              aria-label="Send reply"
              disabled={!reply.trim() || isPending}
            >
              {isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span className="ml-1">Send reply</span>
            </Button>
          </div>
        </motion.form>
      ) : (
        <motion.div
          key="reply-trigger"
          initial={{ height: 0, marginTop: 0, opacity: 0 }}
          animate={{ height: "auto", marginTop: 12, opacity: 1 }}
          exit={{ height: 0, marginTop: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeInOut" }}
          className="flex justify-end overflow-hidden"
        >
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={onStartReply}
          >
            <MessageCircle className="mr-1.5 h-3.5 w-3.5" />
            Reply
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function FeedbackResolutionFooter({
  state,
  resolution,
  resolutionNote,
  isPending,
  pendingResolution,
  variant,
  onUpdateResolution,
}: {
  state: FeedbackState;
  resolution: string | null;
  resolutionNote: string | null;
  isPending: boolean;
  pendingResolution: "fixed" | "dismissed" | null | undefined;
  variant: FeedbackCardVariant;
  onUpdateResolution: (resolution: "fixed" | "dismissed" | null) => void;
}): JSX.Element {
  return (
    <footer className="ml-5 border-l border-border/70 bg-muted/[0.06] px-3 pb-3 pt-3">
      {resolution && (
        <div
          className={cn(
            "mb-3 rounded border",
            variant === "inline" ? "px-3 py-2" : "px-2.5 py-1.5",
            resolution === "fixed"
              ? "border-status-working/25 bg-status-working/[0.06]"
              : "border-muted-foreground/25 bg-muted/30"
          )}
        >
          <div
            className={cn(
              "flex items-center gap-1 text-[10px] font-medium",
              resolution === "fixed"
                ? "text-status-working"
                : "text-muted-foreground"
            )}
          >
            {resolution === "fixed" ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            Resolution: {resolution}
          </div>
          {resolutionNote && (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/80">
              {resolutionNote}
            </p>
          )}
        </div>
      )}
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Feedback state
      </p>
      {state !== "open" ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className={
            variant === "inline" ? "ml-auto w-full max-w-48" : "w-full"
          }
          disabled={isPending}
          onClick={() => onUpdateResolution(null)}
        >
          {isPending && pendingResolution === null ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          )}
          Reopen feedback
        </Button>
      ) : (
        <div className={ACTION_ROW_CLASSES[variant]}>
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={isPending}
            onClick={() => onUpdateResolution("dismissed")}
          >
            {isPending && pendingResolution === "dismissed" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="mr-1.5 h-3.5 w-3.5" />
            )}
            Dismiss
          </Button>
          <Button
            type="button"
            size="sm"
            variant="success"
            disabled={isPending}
            onClick={() => onUpdateResolution("fixed")}
          >
            {isPending && pendingResolution === "fixed" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            Mark fixed
          </Button>
        </div>
      )}
    </footer>
  );
}
