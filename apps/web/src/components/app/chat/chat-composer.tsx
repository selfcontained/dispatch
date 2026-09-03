import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";
import { CornerDownRight, SendHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ChatComposerProps = {
  /**
   * Resolves once the message is accepted; rejects when it is not. The draft
   * is cleared only on success so a failed send never eats what was typed.
   */
  onSend: (text: string) => Promise<void>;
  /** When set, the composer is disabled and this explains why. */
  disabledReason: string | null;
  /** An external send is in flight; the input stays usable, the button waits. */
  sending?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * When set, what gets typed answers this question rather than starting a
   * plain message. The × lets the user opt out and send a plain message.
   */
  replyContext?: { excerpt: string; onDismiss: () => void } | null;
};

/**
 * Enter sends, Shift+Enter inserts a newline. An in-progress IME composition
 * is left alone: the Enter that commits a CJK candidate must not send.
 */
export function ChatComposer({
  onSend,
  disabledReason,
  sending = false,
  placeholder = "Message the agent…",
  autoFocus = false,
  replyContext = null,
}: ChatComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();
  const canSend = !disabled && !sending && !inFlight && trimmed.length > 0;

  // Grow with the content up to the CSS max-height, then scroll inside.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = useCallback(() => {
    if (!canSend) return;
    setError(null);
    setInFlight(true);
    // Only the draft that was sent gets cleared: anything typed while the
    // send was pending is a new draft and stays.
    const submitted = text;
    onSend(trimmed)
      .then(() => {
        if (!mountedRef.current) return;
        setText((current) => (current === submitted ? "" : current));
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Message not sent.");
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setInFlight(false);
        textareaRef.current?.focus();
      });
  }, [canSend, onSend, text, trimmed]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      if (event.shiftKey) return;
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [submit]
  );

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      data-testid="chat-composer"
    >
      <div
        className={cn(
          "rounded-lg border border-border bg-card/70 transition-colors",
          disabled
            ? "opacity-70"
            : "focus-within:border-foreground/30 hover:border-foreground/20"
        )}
      >
        {replyContext && !disabled ? (
          <div className="px-2 pt-2">
            <div
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-status-waiting/40 bg-status-waiting/10 py-0.5 pl-2 pr-1 text-[11px] text-foreground"
              data-testid="chat-reply-context"
            >
              <CornerDownRight className="h-3 w-3 shrink-0 text-status-waiting" />
              <span className="shrink-0 text-muted-foreground">
                Replying to:
              </span>
              <span className="max-w-[40ch] truncate">
                {replyContext.excerpt}
              </span>
              <button
                type="button"
                onClick={replyContext.onDismiss}
                className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Send a plain message instead"
                aria-label="Send a plain message instead"
                data-testid="chat-reply-context-dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex items-end">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            maxLength={CHAT_MESSAGE_MAX_CHARS}
            autoFocus={autoFocus}
            placeholder={
              disabled ? "" : replyContext ? "Type your answer…" : placeholder
            }
            aria-label="Message the agent"
            // The box around it is the border; the field itself is bare.
            className={cn(
              "max-h-48 min-h-10 flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-sm shadow-none backdrop-blur-none focus-visible:ring-0"
            )}
            data-testid="chat-composer-input"
          />
          <Button
            type="submit"
            size="icon"
            variant={canSend ? "primary" : "ghost"}
            disabled={!canSend}
            title="Send (Enter)"
            aria-label="Send message"
            data-testid="chat-composer-send"
            className="m-1.5 h-7 w-7 shrink-0"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="px-1 text-[10px] text-muted-foreground">
        {disabledReason ? (
          <span data-testid="chat-composer-disabled-reason">
            {disabledReason}
          </span>
        ) : error ? (
          <span
            role="alert"
            className="text-destructive"
            data-testid="chat-composer-error"
          >
            {error} — your message is still here; press Enter to try again.
          </span>
        ) : (
          <span>Enter to send · Shift+Enter for a new line</span>
        )}
      </div>
    </form>
  );
}
