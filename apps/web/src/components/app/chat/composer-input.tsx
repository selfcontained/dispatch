import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
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

import { seatClasses } from "@/lib/agent-seat";
import { mentionSpans, type Mentionable } from "@/lib/mentions";
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
        role: current.current.slashOpen ? "combobox" : "textbox",
        "aria-label": "Message the agent",
        "aria-multiline": "true",
        "aria-placeholder": current.current.placeholder,
        "aria-disabled": String(current.current.disabled),
        "aria-expanded": String(current.current.slashOpen),
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
                  class: cn(
                    "box-decoration-clone rounded-full border px-1 py-0 text-xs",
                    span.agent.seat !== undefined
                      ? seatClasses(span.agent.seat).face
                      : "border-border bg-muted text-foreground"
                  ),
                  "data-testid": "chat-composer-mention",
                  "data-agent-id": span.agent.id,
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
        if (plainText(next.doc).length > current.current.maxLength) {
          view.updateState(view.state);
          return;
        }
        view.updateState(next);
        if (transaction.docChanged && !transaction.getMeta("external")) {
          current.current.onChange(
            plainText(next.doc),
            textOffset(next.doc, next.selection.from)
          );
        }
        if (transaction.selectionSet)
          current.current.onSelect(textOffset(next.doc, next.selection.from));
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
        const remaining =
          current.current.maxLength -
          plainText(view.state.doc).length +
          textOffset(view.state.doc, view.state.selection.to) -
          textOffset(view.state.doc, view.state.selection.from);
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
  }, []);

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

  return (
    <div
      ref={host}
      onKeyDownCapture={props.onKeyDown}
      onPasteCapture={props.onPaste}
      className="[&_[data-empty=true]]:before:pointer-events-none [&_[data-empty=true]]:before:absolute [&_[data-empty=true]]:before:text-muted-foreground [&_[data-empty=true]]:before:content-[attr(data-placeholder)]"
    />
  );
});
