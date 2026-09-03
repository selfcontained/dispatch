import {
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";
import { SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ChatComposerProps = {
  onSend: (text: string) => void;
  /** When set, the composer is disabled and this explains why. */
  disabledReason: string | null;
  /** A send is in flight; the input stays usable, the button waits. */
  sending?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
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
}: ChatComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();
  const canSend = !disabled && !sending && trimmed.length > 0;

  // Grow with the content up to the CSS max-height, then scroll inside.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend(trimmed);
    setText("");
    textareaRef.current?.focus();
  }, [canSend, onSend, trimmed]);

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
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          maxLength={CHAT_MESSAGE_MAX_CHARS}
          autoFocus={autoFocus}
          placeholder={disabledReason ?? placeholder}
          aria-label="Message the agent"
          className={cn("max-h-48 min-h-10 flex-1 resize-none py-2.5 text-sm")}
          data-testid="chat-composer-input"
        />
        <Button
          type="submit"
          size="icon"
          variant={canSend ? "default" : "ghost"}
          disabled={!canSend}
          title="Send (Enter)"
          aria-label="Send message"
          data-testid="chat-composer-send"
          className="shrink-0"
        >
          <SendHorizontal className="h-4 w-4" />
        </Button>
      </div>
      <div className="px-1 text-[10px] text-muted-foreground">
        {disabledReason ? (
          <span data-testid="chat-composer-disabled-reason">
            {disabledReason}
          </span>
        ) : (
          <span>Enter to send · Shift+Enter for a new line</span>
        )}
      </div>
    </form>
  );
}
