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

  it("preserves queued delivery on the advertised Enter retry, then resets after success", async () => {
    const onSend = vi
      .fn<Parameters<typeof ChatComposer>[0]["onSend"]>()
      .mockRejectedValueOnce(new Error("Temporarily unavailable"))
      .mockResolvedValue(undefined);
    const { input } = renderComposer({ onSend, canQueue: true });
    fireEvent.change(input, { target: { value: "later" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, shiftKey: true });
    const error = await screen.findByTestId("chat-composer-error");
    expect(error.textContent).toContain("press Enter to queue again");
    expect(input.value).toBe("later");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenNthCalledWith(1, "later", [], {
      delivery: "queue",
    });
    expect(onSend).toHaveBeenNthCalledWith(2, "later", [], {
      delivery: "queue",
    });
    await waitFor(() => expect(input.value).toBe(""));

    fireEvent.change(input, { target: { value: "new message" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("new message", []);
    await waitFor(() => expect(input.value).toBe(""));
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

  it.each(["metaKey", "ctrlKey"])(
    "queues with %s + Shift + Enter while busy",
    async (modifier) => {
      const { input, onSend } = renderComposer({ canQueue: true });
      fireEvent.change(input, { target: { value: "urgent" } });
      fireEvent.keyDown(input, {
        key: "Enter",
        shiftKey: true,
        [modifier]: true,
      });
      expect(onSend).toHaveBeenCalledWith("urgent", [], { delivery: "queue" });
      await waitFor(() => expect(input.value).toBe(""));
    }
  );

  it("sends on Enter while busy and keeps Shift+Enter for newlines", async () => {
    const { input, onSend } = renderComposer({ canQueue: true });
    fireEvent.change(input, { target: { value: "later" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("later", []);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("uses a normal send for the shortcut when idle", async () => {
    const { input, onSend } = renderComposer();
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onSend).toHaveBeenCalledWith("hello", []);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("does not queue during an in-flight send", () => {
    const { input, onSend } = renderComposer({
      canQueue: true,
      sending: true,
    });
    fireEvent.change(input, { target: { value: "wait" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ChatComposer @mentions", () => {
  const mentionables = [
    { id: "agt_1", name: "orchestrator", seat: 1 },
    { id: "agt_2", name: "reviewer", seat: 2 },
    { id: "agt_3", name: "builder", seat: 3 },
  ];
  const type = (input: HTMLTextAreaElement, value: string) => {
    fireEvent.change(input, {
      target: { value, selectionStart: value.length },
    });
  };

  it("opens the picker on @, filters as you type, and Enter inserts the name instead of sending", async () => {
    const { onSend, input } = renderComposer({ mentionables });
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    type(input, "@");
    expect(screen.getAllByTestId("mention-option")).toHaveLength(3);
    type(input, "@rev");
    const options = screen.getAllByTestId("mention-option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("reviewer");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("@reviewer "));
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    type(input, "@reviewer look at this");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toBe("@reviewer look at this");
  });

  it("matches a seat number, moves with the arrows, and Escape closes it", () => {
    const { input } = renderComposer({ mentionables });
    type(input, "@3");
    expect(screen.getAllByTestId("mention-option")).toHaveLength(1);
    expect(screen.getByTestId("mention-option").textContent).toContain(
      "builder"
    );
    type(input, "@");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByTestId("mention-option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("mention-picker")).toBeNull();
  });

  it("shows no picker without mentionables", () => {
    const { input } = renderComposer();
    type(input, "@rev");
    expect(screen.queryByTestId("mention-picker")).toBeNull();
  });
});

describe("ChatComposer toolbar pickers", () => {
  const mentionables = [{ id: "agt_review", name: "reviewer", seat: 2 }];
  const slashCommands = [
    { name: "review", description: "Review changes", source: "agent" as const },
    { name: "model", description: "Choose model", source: "dispatch" as const },
  ];

  it("inserts a mention at the saved cursor and preserves the rest of the draft", async () => {
    const { input, onSend } = renderComposer({ mentionables });
    fireEvent.change(input, { target: { value: "Ask to review" } });
    input.setSelectionRange(3, 3);
    fireEvent.click(screen.getByTestId("chat-composer-mention-button"));
    await waitFor(() => expect(input.selectionStart).toBe(5));
    expect(input.value).toBe("Ask @ to review");
    fireEvent.click(screen.getByTestId("mention-option"));
    await waitFor(() => expect(input.value).toBe("Ask @reviewer  to review"));
    expect(document.activeElement).toBe(input);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reopens a dismissed mention query without adding a second @", async () => {
    const { input } = renderComposer({ mentionables });
    fireEvent.change(input, { target: { value: "@rev", selectionStart: 4 } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByTestId("chat-composer-mention-button"));
    await waitFor(() =>
      expect(screen.getByTestId("mention-picker")).toBeTruthy()
    );
    expect(input.value).toBe("@rev");
  });

  it("opens commands at the start and preserves an existing draft when selected", async () => {
    const { input, onSend } = renderComposer({ slashCommands });
    fireEvent.change(input, { target: { value: "check the composer" } });
    fireEvent.click(screen.getByTestId("chat-composer-command-button"));
    await waitFor(() => expect(input.selectionStart).toBe(1));
    expect(input.value).toBe("/ check the composer");
    expect(screen.getAllByTestId("slash-option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("/review check the composer"));
    expect(onSend).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("preserves the draft when a toolbar command is handled locally", async () => {
    const onDispatchCommand = vi.fn(() => true);
    const { input } = renderComposer({ slashCommands, onDispatchCommand });
    fireEvent.change(input, { target: { value: "keep these notes" } });
    fireEvent.click(screen.getByTestId("chat-composer-command-button"));
    await waitFor(() => expect(input.selectionStart).toBe(1));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDispatchCommand).toHaveBeenCalledWith("model");
    expect(input.value).toBe("keep these notes");
    expect(screen.queryByTestId("slash-picker")).toBeNull();
  });

  it("keeps the slash toolbar disabled when replying", () => {
    renderComposer({
      slashCommands,
      replyContext: { excerpt: "Question", onDismiss: vi.fn() },
    });
    const button = screen.getByTestId(
      "chat-composer-command-button"
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Dismiss the reply");
  });

  it("keeps the slash toolbar disabled with attachments", () => {
    renderComposer({ slashCommands });
    fireEvent.change(screen.getByTestId("chat-composer-file-input"), {
      target: {
        files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
      },
    });
    const button = screen.getByTestId(
      "chat-composer-command-button"
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Remove attachments");
  });

  it("reopens a dismissed slash query without adding another prefix", async () => {
    const { input } = renderComposer({ slashCommands });
    fireEvent.change(input, {
      target: { value: "/rev notes", selectionStart: 4 },
    });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByTestId("chat-composer-command-button"));
    await waitFor(() => expect(input.selectionStart).toBe(4));
    expect(screen.getByTestId("slash-picker")).toBeTruthy();
    expect(input.value).toBe("/rev notes");
  });

  it("disables pickers when there are no agents or commands", () => {
    const { input } = renderComposer();
    expect(
      (screen.getByTestId("chat-composer-mention-button") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("chat-composer-command-button") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(input.value).toBe("");
  });
});

describe("ChatComposer slash commands", () => {
  const slashCommands = [
    { name: "skills", description: "List skills", source: "agent" as const },
    { name: "review", description: "Review changes", source: "agent" as const },
    { name: "model", description: "Choose model", source: "dispatch" as const },
  ];

  it("filters advertised commands and inserts the selected command before sending", async () => {
    const { input, onSend } = renderComposer({ slashCommands });
    fireEvent.change(input, { target: { value: "/ski", selectionStart: 4 } });
    expect(screen.getAllByTestId("slash-option")).toHaveLength(1);
    expect(screen.getByTestId("slash-option").textContent).toContain("/skills");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("/skills ");
    fireEvent.change(input, {
      target: { value: "/skills list", selectionStart: 12 },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("/skills list", [])
    );
  });

  it("can consume a Dispatch command locally and dismiss the menu", () => {
    const onDispatchCommand = vi.fn(() => true);
    const { input, onSend } = renderComposer({
      slashCommands,
      onDispatchCommand,
    });
    fireEvent.change(input, { target: { value: "/mo", selectionStart: 3 } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDispatchCommand).toHaveBeenCalledWith("model");
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "/re", selectionStart: 3 } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("slash-picker")).toBeNull();
  });

  it("opens again after Escape when the draft is deleted and retyped", () => {
    const { input } = renderComposer({ slashCommands });
    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    expect(screen.getByTestId("slash-picker")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("slash-picker")).toBeNull();
    fireEvent.change(input, { target: { value: "", selectionStart: 0 } });
    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    expect(screen.getByTestId("slash-picker")).toBeTruthy();
  });

  it("connects the focused field to the active suggestion", () => {
    const { input } = renderComposer({ slashCommands });
    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    const list = screen.getByTestId("slash-picker");
    const options = screen.getAllByTestId("slash-option");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
  });

  it("does not offer or send an agent command with an attachment or mention", () => {
    const { input, onSend } = renderComposer({
      slashCommands,
      mentionables: [{ id: "agt_1", name: "builder", seat: 1 }],
    });
    const fileInput = screen.getByTestId("chat-composer-file-input");
    fireEvent.change(fileInput, {
      target: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });
    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    expect(screen.queryByTestId("slash-picker")).toBeNull();
    fireEvent.change(input, {
      target: { value: "/skills", selectionStart: 7 },
    });
    expect(screen.queryByTestId("slash-picker")).toBeNull();
    expect(
      screen.getByTestId("chat-composer-slash-hint").textContent
    ).toContain("Remove attachments");
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    fireEvent.change(input, {
      target: { value: "/skills @builder", selectionStart: 16 },
    });
    expect(
      screen.getByTestId("chat-composer-slash-hint").textContent
    ).toContain("Remove agent mentions");
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("leaves Shift+Enter and Shift+Tab to normal textarea behavior", () => {
    const { input, onSend } = renderComposer({ slashCommands });
    fireEvent.change(input, { target: { value: "/ski", selectionStart: 4 } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(input.value).toBe("/ski");
    expect(screen.getByTestId("slash-picker")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });
});
