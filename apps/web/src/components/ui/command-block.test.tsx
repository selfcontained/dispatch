// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandBlock } from "./command-block";

const COMMAND =
  "curl -fsSL https://example.test/install.sh -o /tmp/install.sh \\\n  && sudo bash /tmp/install.sh";

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard"
);
const originalExecCommand = document.execCommand;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
  document.execCommand = originalExecCommand;
  vi.restoreAllMocks();
});

describe("CommandBlock", () => {
  it("renders the content verbatim, line breaks included", () => {
    render(<CommandBlock text={COMMAND} testId="cmd" />);
    expect(screen.getByTestId("cmd").textContent).toBe(COMMAND);
  });

  it("copies the exact multiline text and shows the check", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(
      <CommandBlock
        text={COMMAND}
        label="Copy install command"
        copiedLabel="Copied install command"
      />
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy install command" })
      );
    });

    expect(writeText).toHaveBeenCalledWith(COMMAND);
    const copied = screen.getByRole("button", {
      name: "Copied install command",
    });
    expect(copied.getAttribute("data-copied")).toBe("true");
  });

  it("copies the exact text without the Clipboard API from inside a dialog", () => {
    setClipboard(undefined);
    let clipboardText: string | undefined;
    let textareaParent: Element | null = null;
    document.execCommand = vi.fn(() => {
      textareaParent =
        document.querySelector("textarea")?.parentElement ?? null;
      const data = new Map<string, string>();
      const event = Object.assign(new Event("copy", { cancelable: true }), {
        clipboardData: {
          setData: (type: string, value: string) => data.set(type, value),
        },
      });
      document.dispatchEvent(event);
      clipboardText = data.get("text/plain");
      return true;
    });

    render(
      <div role="dialog">
        <CommandBlock text={COMMAND} label="Copy" copiedLabel="Copied" />
      </div>
    );
    const button = screen.getByRole("button", { name: "Copy" });
    button.focus();
    fireEvent.click(button);

    expect(clipboardText).toBe(COMMAND);
    expect(textareaParent).toBe(screen.getByRole("dialog"));
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.getByRole("button", { name: "Copied" })).toBe(
      document.activeElement
    );
  });
});
