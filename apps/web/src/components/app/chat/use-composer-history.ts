import { useCallback, useRef, useState, type KeyboardEvent } from "react";

/** Where the caret sits relative to the field's lines. */
function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
  return !el.value.slice(0, el.selectionStart ?? 0).includes("\n");
}
function caretOnLastLine(el: HTMLTextAreaElement): boolean {
  return !el.value.slice(el.selectionEnd ?? 0).includes("\n");
}

/**
 * Shell-style prompt history for a composer. With the field empty, ArrowUp
 * first asks the host for a queued message to take back (`recallQueued`),
 * then walks `history` backwards; ArrowDown walks forward to the empty
 * draft. While an entry is shown, the arrows only take over at the first
 * and last line, so a multi-line recall can still be edited with the
 * keyboard. Typing resets to a fresh draft.
 */
export function useComposerHistory({
  text,
  history,
  recallQueued,
  setText,
  setCaret,
}: {
  text: string;
  history: string[] | undefined;
  recallQueued: (() => Promise<string | null>) | undefined;
  setText: (next: string) => void;
  setCaret: (at: number) => void;
}): {
  onArrowUp: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onArrowDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  reset: () => void;
} {
  // null while typing a fresh draft; otherwise the shown entry's index.
  const [index, setIndex] = useState<number | null>(null);
  const recalling = useRef(false);
  const show = useCallback(
    (at: number | null, entries: string[]) => {
      setIndex(at);
      const value = at === null ? "" : entries[at];
      setText(value);
      setCaret(value.length);
    },
    [setCaret, setText]
  );

  const onArrowUp = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return false;
      const el = event.currentTarget;
      const entries = history ?? [];
      if (index === null) {
        if (text !== "") return false;
        if (entries.length === 0 && !recallQueued) return false;
        event.preventDefault();
        void (async () => {
          if (recallQueued && !recalling.current) {
            recalling.current = true;
            try {
              const queued = await recallQueued();
              if (queued !== null) {
                setText(queued);
                setCaret(queued.length);
                return;
              }
            } catch {
              // The host reports it; fall through to the history.
            } finally {
              recalling.current = false;
            }
          }
          if (entries.length > 0) show(entries.length - 1, entries);
        })();
        return true;
      }
      if (!caretOnFirstLine(el)) return false;
      event.preventDefault();
      if (index > 0) show(index - 1, entries);
      return true;
    },
    [history, index, recallQueued, setCaret, setText, show, text]
  );

  const onArrowDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || index === null) return false;
      if (!caretOnLastLine(event.currentTarget)) return false;
      event.preventDefault();
      const entries = history ?? [];
      show(index < entries.length - 1 ? index + 1 : null, entries);
      return true;
    },
    [history, index, show]
  );

  const reset = useCallback(() => setIndex(null), []);
  return { onArrowUp, onArrowDown, reset };
}
