// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "@/components/app/chat/chat-composer";

afterEach(() => {
  cleanup();
});

function renderComposer(
  props: Partial<Parameters<typeof ChatComposer>[0]> = {}
) {
  const onSend = vi.fn(
    async (_text: string, _attachments: unknown[]) => undefined
  );
  render(
    <ChatComposer
      agentId={null}
      onSend={onSend}
      disabledReason={null}
      {...props}
    />
  );
  const input = screen.getByTestId(
    "chat-composer-input"
  ) as HTMLTextAreaElement;
  return { onSend, input };
}

describe("ChatComposer", () => {
  it("sends on Enter and clears the input once the send succeeds", async () => {
    const { onSend, input } = renderComposer();
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello", []);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps a draft typed while the previous send was pending", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        })
    );
    render(
      <ChatComposer agentId={null} onSend={onSend} disabledReason={null} />
    );
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("first", []);

    fireEvent.change(input, { target: { value: "second draft" } });
    await act(async () => {
      resolve();
    });
    expect(input.value).toBe("second draft");

    // The new draft sends normally once the first has settled.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("second draft", []);
  });

  it("keeps the draft and shows the error when the send fails", async () => {
    let reject!: (err: Error) => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
        })
    );
    render(
      <ChatComposer agentId={null} onSend={onSend} disabledReason={null} />
    );
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "important" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // In flight: the draft stays and a second Enter does not double-send.
    expect(input.value).toBe("important");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      reject(new Error("Agent has no terminal"));
    });
    expect(input.value).toBe("important");
    const error = screen.getByTestId("chat-composer-error");
    expect(error.textContent).toContain("Agent has no terminal");
    // The draft survived, so a retry is on offer.
    expect(error.textContent).toContain("press Enter to try again");
    expect(error.getAttribute("data-retryable")).toBe("true");

    // Retrying clears the error and sends the same draft again.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith("important", []);
    expect(screen.queryByTestId("chat-composer-error")).toBeNull();
  });

  it("does not send on Shift+Enter", () => {
    const { onSend, input } = renderComposer();
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("line one");
  });

  it("does not send an empty or whitespace-only message", () => {
    const { onSend, input } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("leaves an in-progress IME composition alone", () => {
    const { onSend, input } = renderComposer();
    fireEvent.change(input, { target: { value: "日本" } });
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", { value: true });
    input.dispatchEvent(event);
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("日本");
  });

  it("sends from the button too", async () => {
    const { onSend, input } = renderComposer();
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.click(screen.getByTestId("chat-composer-send"));
    expect(onSend).toHaveBeenCalledWith("go", []);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("is disabled with an explanation when there is no terminal to send to", () => {
    const { onSend, input } = renderComposer({
      disabledReason: "The agent is not running.",
    });
    expect(input.disabled).toBe(true);
    // The reason is stated once, in the helper line, not echoed as placeholder.
    expect(input.placeholder).toBe("");
    expect(
      screen.getByTestId("chat-composer-disabled-reason").textContent
    ).toBe("The agent is not running.");
    expect(screen.getAllByText("The agent is not running.")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the reply context chip and lets the user opt out of it", () => {
    const onDismiss = vi.fn();
    const { input } = renderComposer({
      replyContext: { excerpt: "Ship it now or wait?", onDismiss },
    });
    const chip = screen.getByTestId("chat-reply-context");
    expect(chip.textContent).toContain("Replying to:");
    expect(chip.textContent).toContain("Ship it now or wait?");
    expect(input.placeholder).toBe("Type your answer…");
    fireEvent.click(screen.getByTestId("chat-reply-context-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides the reply context chip while the composer is disabled", () => {
    renderComposer({
      replyContext: { excerpt: "Q", onDismiss: vi.fn() },
      disabledReason: "The agent is not running.",
    });
    expect(screen.queryByTestId("chat-reply-context")).toBeNull();
  });

  it("keeps the input usable but holds the button while a send is in flight", () => {
    const { input } = renderComposer({ sending: true });
    fireEvent.change(input, { target: { value: "next" } });
    expect(input.disabled).toBe(false);
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("gives the Send button a 44px target on coarse pointers only", () => {
    // Desktop keeps the compact icon; the pointer-coarse variant (see
    // tailwind.config.ts) swaps in the 44px minimum without an inset so the
    // button still sits inside the composer box.
    renderComposer();
    const send = screen.getByTestId("chat-composer-send");
    expect(send.className).toMatch(/\bh-7\b/);
    expect(send.className).toMatch(/\bw-7\b/);
    expect(send.className).toContain("pointer-coarse:min-h-11");
    expect(send.className).toContain("pointer-coarse:min-w-11");
    expect(send.className).toContain("pointer-coarse:m-0");
    const disc = screen.getByTestId("chat-composer-send-disc");
    expect(disc.className).toContain("pointer-coarse:h-7");
    expect(disc.className).toContain("pointer-coarse:w-7");
  });
});
