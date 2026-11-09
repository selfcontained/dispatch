import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Schema, Slice, type Node as DocumentNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { baseKeymap, splitBlock } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import "prosemirror-view/style/prosemirror.css";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  emojiQueryAt,
  emojiShortcodes,
  matchEmoji,
} from "@/lib/emoji-shortcodes";

import {
  mentionChipClasses,
  mentionSpans,
  type Mentionable,
} from "@/lib/mentions";
import { cn } from "@/lib/utils";

// Plain text is still the persisted/API value. Decorations only affect layout;
// mentions remain editable text, with no hidden characters or synthetic spaces.
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "text*",
      group: "block",
      whitespace: "pre",
      parseDOM: [{ tag: "p" }, { tag: "div" }],
      toDOM: () => ["p", { class: "m-0" }, 0],
    },
    text: { group: "inline" },
  },
});

function documentFromText(text: string): DocumentNode {
  return schema.node(
    "doc",
    null,
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) =>
        schema.node("paragraph", null, line ? schema.text(line) : undefined)
      )
  );
}
function plainText(doc: DocumentNode): string {
  return doc.textBetween(0, doc.content.size, "\n");
}
function textOffset(doc: DocumentNode, position: number): number {
  let result = 0;
  doc.forEach((paragraph, start) => {
    if (position > start)
      result += Math.min(position - start - 1, paragraph.content.size);
    if (position > start + paragraph.nodeSize) result += 1;
  });
  return result;
}
function documentPosition(doc: DocumentNode, offset: number): number {
  let remaining = Math.max(0, offset);
  let result = doc.content.size - 1;
  let found = false;
  doc.forEach((paragraph, start) => {
    if (found) return;
    if (remaining <= paragraph.content.size) {
      result = start + 1 + remaining;
      found = true;
    } else remaining -= paragraph.content.size + 1;
  });
  return result;
}

export interface ComposerInputHandle {
  readonly element: HTMLDivElement | null;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setValue(value: string, caret: number): void;
  setSelectionRange(start: number, end: number): void;
}

export interface ComposerInputProps {
  value: string;
  mentionables: readonly Mentionable[];
  disabled: boolean;
  placeholder: string;
  maxLength: number;
  onChange(value: string, caret: number): void;
  onSelect(caret: number): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onPaste(event: ClipboardEvent<HTMLDivElement>): void;
  slashOpen: boolean;
  slashListId: string;
  activeSlash: number;
}

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  ComposerInputProps
>(function ComposerInput(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const current = useRef(props);
  const [cursor, setCursor] = useState({ text: props.value, caret: 0, end: 0 });
  const [dismissed, setDismissed] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const query = emojiQueryAt(cursor.text, cursor.caret);
  const signature = `${cursor.caret}:${cursor.text}`;
  const candidates =
    query &&
    dismissed !== signature &&
    cursor.caret === cursor.end &&
    !props.slashOpen &&
    !props.disabled
      ? matchEmoji(query.query)
      : [];
  const selected = Math.min(active, candidates.length - 1);
  const popup = useRef({ open: false, selected: 0 });
  popup.current = { open: candidates.length > 0, selected };
  function pickEmoji(emoji: string) {
    const view = editor.current;
    if (!view || !query) return;
    view.dispatch(
      closeHistory(view.state.tr)
        .insertText(
          emoji,
          documentPosition(view.state.doc, query.start),
          documentPosition(view.state.doc, cursor.caret)
        )
        .scrollIntoView()
    );
    view.focus();
  }

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return (editor.current?.dom as HTMLDivElement) ?? null;
      },
      get selectionStart() {
        const state = editor.current?.state;
        return state ? textOffset(state.doc, state.selection.from) : 0;
      },
      get selectionEnd() {
        const state = editor.current?.state;
        return state ? textOffset(state.doc, state.selection.to) : 0;
      },
      focus() {
        editor.current?.focus();
      },
      setValue(value, caret) {
        const view = editor.current;
        if (!view) return;
        const transaction = closeHistory(view.state.tr).replaceWith(
          0,
          view.state.doc.content.size,
          documentFromText(value).content
        );
        transaction.setSelection(
          TextSelection.create(
            transaction.doc,
            documentPosition(transaction.doc, caret)
          )
        );
        view.dispatch(transaction.setMeta("external", true).scrollIntoView());
      },
      setSelectionRange(start, end) {
        const view = editor.current;
        if (!view) return;
        const clamp = (position: number) =>
          documentPosition(view.state.doc, position);
        view.dispatch(
          view.state.tr
            .setSelection(
              TextSelection.create(view.state.doc, clamp(start), clamp(end))
            )
            .scrollIntoView()
        );
      },
    }),
    []
  );

  useLayoutEffect(() => {
    const view = new EditorView(host.current!, {
      state: EditorState.create({
        schema,
        doc: documentFromText(current.current.value),
        plugins: [
          history(),
          keymap({
            ...baseKeymap,
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Shift-Enter": splitBlock,
          }),
        ],
      }),
      editable: () => !current.current.disabled,
      attributes: (state) => ({
        class: cn(
          "min-h-14 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-t-2xl px-4 pb-2 pt-4 text-sm leading-6 text-foreground caret-foreground outline-none pointer-coarse:text-base selection:bg-primary selection:text-primary-foreground",
          current.current.disabled && "opacity-50"
        ),
        role:
          current.current.slashOpen || popup.current.open
            ? "combobox"
            : "textbox",
        "aria-label": "Message the agent",
        "aria-multiline": "true",
        "aria-placeholder": current.current.placeholder,
        "aria-disabled": String(current.current.disabled),
        "aria-expanded": String(
          current.current.slashOpen || popup.current.open
        ),
        ...(popup.current.open
          ? {
              "aria-autocomplete": "list",
              "aria-controls": listId,
              "aria-activedescendant": `${listId}-${popup.current.selected}`,
            }
          : {}),
        ...(current.current.slashOpen
          ? {
              "aria-autocomplete": "list",
              "aria-haspopup": "listbox",
              "aria-controls": current.current.slashListId,
              "aria-activedescendant": `${current.current.slashListId}-option-${current.current.activeSlash}`,
            }
          : {}),
        "data-chat-composer": "",
        "data-testid": "chat-composer-input",
        "data-placeholder": current.current.placeholder,
        "data-empty": String(!plainText(state.doc)),
        tabindex: current.current.disabled ? "-1" : "0",
      }),
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.forEach((paragraph, start) => {
          let position = start + 1;
          for (const span of mentionSpans(
            paragraph.textContent,
            current.current.mentionables
          )) {
            if (span.kind === "mention") {
              decorations.push(
                Decoration.inline(position, position + span.text.length, {
                  class: mentionChipClasses(span.agent.seat, span.silent),
                  "data-silent": String(!!span.silent),
                  "data-testid": "chat-composer-mention",
                  "data-agent-id": span.agent.id,
                  title: span.silent
                    ? "Reference only — won’t notify"
                    : span.agent.name,
                })
              );
            }
            position += span.text.length;
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction);
        // A failed post may restore text alongside a full new draft. Show
        // all recovered text and allow deletion until it fits the send limit.
        if (
          transaction.docChanged &&
          !transaction.getMeta("external") &&
          plainText(next.doc).length > current.current.maxLength &&
          plainText(next.doc).length >= plainText(view.state.doc).length
        ) {
          view.updateState(view.state);
          return;
        }
        view.updateState(next);
        setCursor({
          text: plainText(next.doc),
          caret: textOffset(next.doc, next.selection.from),
          end: textOffset(next.doc, next.selection.to),
        });
        setActive(0);
        if (transaction.docChanged || transaction.selectionSet)
          setDismissed("");
        if (transaction.docChanged && !transaction.getMeta("external")) {
          current.current.onChange(
            plainText(next.doc),
            textOffset(next.doc, next.selection.from)
          );
        }
        if (transaction.selectionSet)
          current.current.onSelect(textOffset(next.doc, next.selection.from));
      },
      handleTextInput(view, from, to, text) {
        if (text !== ":" || from !== to || view.composing) return false;
        const value = plainText(view.state.doc);
        const caret = textOffset(view.state.doc, from);
        const query = emojiQueryAt(value, caret);
        const emoji = query && emojiShortcodes[query.query];
        if (!emoji) return false;
        // Preserve the complete typed alias as the previous undo state.
        view.dispatch(view.state.tr.insertText(text, from, to));
        view.dispatch(
          closeHistory(view.state.tr).insertText(
            emoji,
            documentPosition(view.state.doc, query.start),
            from + 1
          )
        );
        return true;
      },
      // Rich clipboard markup never enters the plain-text document.
      clipboardTextParser: (text) =>
        new Slice(documentFromText(text).content, 1, 1),
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, "\n"),
      handlePaste(view, event) {
        const text =
          event.clipboardData?.getData("text/plain").replace(/\r\n?/g, "\n") ??
          "";
        const remaining = Math.max(
          0,
          current.current.maxLength -
            plainText(view.state.doc).length +
            textOffset(view.state.doc, view.state.selection.to) -
            textOffset(view.state.doc, view.state.selection.from)
        );
        view.dispatch(
          view.state.tr
            .replaceSelection(
              new Slice(
                documentFromText(text.slice(0, remaining)).content,
                1,
                1
              )
            )
            .scrollIntoView()
        );
        return true;
      },
      // Keep the caret visible inside the editor's own scroller only. The
      // default walk also scrolls the window by visualViewport height, which
      // ignores its offset: on iPad a short or panned visual viewport made
      // every keystroke scroll the locked page, and iOS pans it back.
      handleScrollToSelection(view) {
        const scroller = view.dom;
        const box = scroller.getBoundingClientRect();
        const style = getComputedStyle(scroller);
        const top = box.top + (parseFloat(style.paddingTop) || 0);
        const bottom = box.bottom - (parseFloat(style.paddingBottom) || 0);
        const caret = view.coordsAtPos(view.state.selection.head);
        if (caret.top < top) scroller.scrollTop -= top - caret.top;
        else if (caret.bottom > bottom)
          scroller.scrollTop += caret.bottom - bottom;
        return true;
      },
      handleDOMEvents: {
        // The parent handles file drops; don't let the editor parse them.
        drop: (_view, event) => !!event.dataTransfer?.files.length,
      },
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [listId]);

  useLayoutEffect(() => {
    current.current = props;
    const view = editor.current;
    if (!view) return;
    if (plainText(view.state.doc) !== props.value) {
      const from = textOffset(view.state.doc, view.state.selection.from);
      const to = textOffset(view.state.doc, view.state.selection.to);
      const transaction = closeHistory(view.state.tr).replaceWith(
        0,
        view.state.doc.content.size,
        documentFromText(props.value).content
      );
      transaction.setSelection(
        TextSelection.create(
          transaction.doc,
          documentPosition(transaction.doc, from),
          documentPosition(transaction.doc, to)
        )
      );
      view.dispatch(transaction.setMeta("external", true));
    }
    view.setProps({});
  }, [props]);

  useLayoutEffect(() => {
    editor.current?.setProps({});
  });

  const rect = editor.current?.dom.getBoundingClientRect();
  return (
    <>
      {candidates.length > 0 &&
        rect &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-label="Emoji shortcodes"
            className="fixed z-50 w-64 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{
              left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)),
              bottom: Math.max(8, window.innerHeight - rect.top + 4),
              maxWidth: "calc(100vw - 16px)",
              maxHeight: Math.max(48, rect.top - 16),
            }}
          >
            {candidates.map(([alias, emoji], index) => (
              <Button
                key={alias}
                type="button"
                variant="ghost"
                role="option"
                id={`${listId}-${index}`}
                aria-selected={index === selected}
                className={cn(
                  "flex w-full justify-start gap-2",
                  index === selected && "bg-accent"
                )}
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => pickEmoji(emoji)}
              >
                <span aria-hidden="true">{emoji}</span>:{alias}:
              </Button>
            ))}
          </div>,
          document.body
        )}
      <div
        ref={host}
        onKeyDownCapture={(event) => {
          if (candidates.length && !event.nativeEvent.isComposing) {
            if (
              ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(
                event.key
              )
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") setDismissed(signature);
              else if (event.key === "ArrowDown" || event.key === "ArrowUp")
                setActive(
                  (selected +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    candidates.length) %
                    candidates.length
                );
              else pickEmoji(candidates[selected]![1]);
              return;
            }
          }
          props.onKeyDown(event);
        }}
        onPasteCapture={props.onPaste}
        className="[&_[data-empty=true]]:before:pointer-events-none [&_[data-empty=true]]:before:absolute [&_[data-empty=true]]:before:text-muted-foreground [&_[data-empty=true]]:before:content-[attr(data-placeholder)]"
      />
    </>
  );
});
