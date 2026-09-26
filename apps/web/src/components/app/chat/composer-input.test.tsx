// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerInput,
  type ComposerInputHandle,
  type ComposerInputProps,
} from "./composer-input";

const mentionables = [{ id: "review", name: "reviewer", seat: 1 }];
const base: ComposerInputProps = {
  value: "",
  mentionables,
  disabled: false,
  placeholder: "Type a message",
  maxLength: 20000,
  onChange: () => {},
  onSelect: () => {},
  onKeyDown: () => {},
  onPaste: () => {},
  slashOpen: false,
  slashListId: "commands",
  activeSlash: 0,
};
beforeEach(() => {
  // ProseMirror scrolls native selections; jsdom supplies no geometry.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(value = "", extra: Partial<ComposerInputProps> = {}) {
  const ref = createRef<ComposerInputHandle>();
  const changed = vi.fn();
  function Harness() {
    const [text, setText] = useState(value);
    return (
      <ComposerInput
        {...base}
        {...extra}
        ref={ref}
        value={text}
        onChange={(next, caret) => {
          changed(next, caret);
          setText(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { ref, changed, input: screen.getByTestId("chat-composer-input") };
}

// Simulate the DOM mutation made by the browser's native editing engine. The
// editor observes it, parses it, and emits the same plain-text value as typing.
async function nativeEdit(input: HTMLElement, lines: string[]) {
  await act(async () => {
    input.replaceChildren(
      ...lines.map((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        return p;
      })
    );
    fireEvent.input(input, { inputType: "insertText" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ComposerInput plain-text editing", () => {
  it("sets picker text and the caret atomically before another edit", () => {
    const { ref } = setup("@");
    act(() => {
      ref.current!.setValue("@reviewer ", 10);
      ref.current!.focus();
    });
    expect(ref.current!.selectionStart).toBe(10);
    expect(ref.current!.selectionEnd).toBe(10);
    const selection = window.getSelection()!;
    expect(
      selection.anchorNode?.textContent?.slice(0, selection.anchorOffset)
    ).toBe(" ");
  });
  it("exposes a disabled editor as read-only and removes it from tab order", () => {
    const { input } = setup("read only", { disabled: true });
    expect(input.getAttribute("contenteditable")).toBe("false");
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect(input.tabIndex).toBe(-1);
  });

  it("decorates known mentions without changing the draft or normal typography", () => {
    const { input } = setup("@reviewer @reviewer next");
    expect(input.textContent).toBe("@reviewer @reviewer next");
    expect(screen.getAllByTestId("chat-composer-mention")).toHaveLength(2);
    expect(input.className).toContain("text-sm");
    expect(input.className).toContain("pointer-coarse:text-base");
    expect(
      screen.getAllByTestId("chat-composer-mention")[0]!.className
    ).toContain("text-xs");
  });
  it("maps plain-text selection offsets across lines and emoji", () => {
    const text = "Hi 😀\n@reviewer tail\nlast";
    const { ref } = setup(text);
    act(() => {
      ref.current!.focus();
      ref.current!.setSelectionRange(6, 15);
    });
    expect(ref.current!.selectionStart).toBe(6);
    expect(ref.current!.selectionEnd).toBe(15);
    expect(window.getSelection()?.toString()).toBe("@reviewer");
    act(() => ref.current!.setSelectionRange(text.length, text.length));
    expect(ref.current!.selectionStart).toBe(text.length);
  });
  it("redecorates native edits and preserves empty lines", async () => {
    const { input, changed } = setup("@reviewer");
    await nativeEdit(input, ["@reviewe", "", "last"]);
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        "@reviewe\n\nlast",
        expect.any(Number)
      )
    );
    expect(screen.queryByTestId("chat-composer-mention")).toBeNull();
  });
  it("pastes plain text instead of HTML, preserving newlines", () => {
    const { input, ref, changed } = setup("Start ");
    act(() => ref.current!.setSelectionRange(6, 6));
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) =>
          type === "text/plain" ? "@reviewer\nnext" : "<b>wrong</b>",
        files: [],
      },
    });
    expect(changed).toHaveBeenLastCalledWith(
      "Start @reviewer\nnext",
      expect.any(Number)
    );
    expect(input.querySelector("b")).toBeNull();
  });
  it("supports line breaks, undo, and redo without losing text", () => {
    const { input, ref, changed } = setup("Hello");
    act(() => ref.current!.setSelectionRange(5, 5));
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(changed).toHaveBeenLastCalledWith("Hello\n", 6);
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(changed).toHaveBeenLastCalledWith("Hello", 5);
    fireEvent.keyDown(input, { key: "z", ctrlKey: true, shiftKey: true });
    expect(changed).toHaveBeenLastCalledWith("Hello\n", 6);
  });
  it("updates restored drafts without reporting them as user edits", () => {
    const change = vi.fn();
    const ref = createRef<ComposerInputHandle>();
    const result = render(
      <ComposerInput {...base} ref={ref} value="old" onChange={change} />
    );
    result.rerender(
      <ComposerInput
        {...base}
        ref={ref}
        value={"@reviewer\nrestored"}
        onChange={change}
      />
    );
    expect(screen.getByTestId("chat-composer-input").textContent).toBe(
      "@reviewerrestored"
    );
    expect(screen.getByTestId("chat-composer-mention").textContent).toBe(
      "@reviewer"
    );
    expect(change).not.toHaveBeenCalled();
  });
  it("truncates paste at the character limit", () => {
    const { input, ref, changed } = setup("123", { maxLength: 5 });
    act(() => ref.current!.setSelectionRange(3, 3));
    fireEvent.paste(input, {
      clipboardData: { getData: () => "45678", files: [] },
    });
    expect(changed).toHaveBeenLastCalledWith("12345", 5);
  });
});
