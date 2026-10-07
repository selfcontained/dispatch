// Composer orchestration tests use a native field; the actual editor's document,
// decoration, and selection behavior is covered in composer-input.test.tsx and
// focused browser checks (jsdom has no layout or native editing engine).
import { forwardRef, useImperativeHandle, useRef } from "react";
import type {
  ComposerInputHandle,
  ComposerInputProps,
} from "@/components/app/chat/composer-input";

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  ComposerInputProps
>(function ComposerInput(props, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    get element() {
      return input.current as unknown as HTMLDivElement;
    },
    get selectionStart() {
      return input.current?.selectionStart ?? 0;
    },
    get selectionEnd() {
      return input.current?.selectionEnd ?? 0;
    },
    focus() {
      input.current?.focus();
    },
    setValue(value, caret) {
      if (input.current) {
        input.current.value = value;
        input.current.setSelectionRange(caret, caret);
      }
    },
    setSelectionRange(start, end) {
      input.current?.setSelectionRange(start, end);
    },
  }));
  return (
    <textarea
      ref={input}
      data-chat-composer
      data-testid="chat-composer-input"
      aria-label="Message the agent"
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      role={props.slashOpen ? "combobox" : undefined}
      aria-autocomplete={props.slashOpen ? "list" : undefined}
      aria-haspopup={props.slashOpen ? "listbox" : undefined}
      aria-expanded={props.slashOpen || undefined}
      aria-controls={props.slashOpen ? props.slashListId : undefined}
      aria-activedescendant={
        props.slashOpen
          ? `${props.slashListId}-option-${props.activeSlash}`
          : undefined
      }
      onChange={(e) => props.onChange(e.target.value, e.target.selectionStart)}
      onSelect={(e) => props.onSelect(e.currentTarget.selectionStart)}
      onKeyDown={(e) =>
        props.onKeyDown(
          e as unknown as Parameters<ComposerInputProps["onKeyDown"]>[0]
        )
      }
      onPaste={(e) =>
        props.onPaste(
          e as unknown as Parameters<ComposerInputProps["onPaste"]>[0]
        )
      }
    />
  );
});
