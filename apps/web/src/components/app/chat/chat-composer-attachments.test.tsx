// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "@/components/app/chat/chat-composer";
import type { AgentPin } from "@/components/app/types";

import {
  isLongPaste,
  nextPastedFileName,
  pastedLinkUrl,
} from "./chat-attachments";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom has no object URLs; image chips ask for one for their thumbnail.
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:preview"),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

const pins: AgentPin[] = [
  {
    id: "pin-1",
    label: "Dev URL",
    value: "http://localhost:5173",
    type: "url",
  },
  { id: "pin-2", label: "Branch", value: "feat/x", type: "string" },
  { label: "No id", value: "x", type: "string" },
  { id: "pin-3", label: "Run it", value: "go", type: "shortcut" },
];

function renderComposer(
  props: Partial<Parameters<typeof ChatComposer>[0]> = {}
) {
  const onSend = vi.fn(
    async (_text: string, _attachments: unknown[]) => undefined
  );
  const uploadFile = vi.fn(async (file: File) => ({
    id: file.name.length,
  }));
  render(
    <ChatComposer
      agentId={null}
      onSend={onSend}
      uploadFile={uploadFile}
      pins={pins}
      disabledReason={null}
      {...props}
    />
  );
  const input = screen.getByTestId(
    "chat-composer-input"
  ) as HTMLTextAreaElement;
  return { onSend, uploadFile, input };
}

function pasteFiles(target: HTMLElement, files: File[]): boolean {
  return fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: () => "",
    },
  });
}

function pasteText(target: HTMLElement, text: string): boolean {
  return fireEvent.paste(target, {
    clipboardData: { items: [], getData: () => text },
  });
}

describe("chat-attachments helpers", () => {
  it("treats only a lone absolute http(s) URL as a link paste", () => {
    expect(pastedLinkUrl("https://example.com/x?y=1")).toBe(
      "https://example.com/x?y=1"
    );
    expect(pastedLinkUrl("  http://example.com  ")).toBe("http://example.com");
    expect(pastedLinkUrl("example.com")).toBeNull();
    expect(pastedLinkUrl("see https://example.com for details")).toBeNull();
    expect(pastedLinkUrl("ftp://example.com")).toBeNull();
  });

  it("flags a paste as long by characters or by lines", () => {
    expect(isLongPaste("a".repeat(4_000))).toBe(false);
    expect(isLongPaste("a".repeat(4_001))).toBe(true);
    expect(isLongPaste(Array(80).fill("l").join("\n"))).toBe(false);
    expect(isLongPaste(Array(81).fill("l").join("\n"))).toBe(true);
  });

  it("numbers pasted.txt when one is already attached", () => {
    expect(nextPastedFileName([])).toBe("pasted.txt");
    expect(nextPastedFileName(["pasted.txt"])).toBe("pasted-2.txt");
    expect(nextPastedFileName(["pasted.txt", "pasted-2.txt"])).toBe(
      "pasted-3.txt"
    );
  });
});

describe("ChatComposer attachments", () => {
  it("turns pasted files into chips, with a thumbnail for images", () => {
    const { input } = renderComposer();
    const image = new File(["png"], "shot.png", { type: "image/png" });
    const doc = new File(["pdf"], "spec.pdf", { type: "application/pdf" });
    const notPrevented = pasteFiles(input, [image, doc]);
    expect(notPrevented).toBe(false);

    const chips = screen.getAllByTestId("context-file-item");
    expect(chips.map((c) => c.getAttribute("data-file-name"))).toEqual([
      "shot.png",
      "spec.pdf",
    ]);
    expect(chips[0]!.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview"
    );
    expect(chips[1]!.querySelector("img")).toBeNull();
    // Attachments alone are enough to send.
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("gives a pasted image a thumbnail even when its File carries no MIME type", () => {
    // WebKit and some Chrome paste paths hand over `image.png` with an
    // empty `type`; the name still says what it is.
    const { input } = renderComposer();
    pasteFiles(input, [new File(["png"], "image.png", { type: "" })]);
    const chip = screen.getByTestId("context-file-item");
    expect(chip.getAttribute("data-file-name")).toBe("image.png");
    expect(chip.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  });

  it("clears the text and every kind of chip once a send resolves", async () => {
    const { onSend, input } = renderComposer();
    pasteFiles(input, [
      new File(["png"], "image.png", { type: "" }),
      new File(["notes"], "notes.md", { type: "text/markdown" }),
    ]);
    pasteText(input, "https://example.com/x");
    pasteText(input, "line\n".repeat(90));
    fireEvent.click(screen.getByTestId("chat-composer-pin-button"));
    fireEvent.click(
      (await screen.findAllByTestId("chat-composer-pin-option"))[0]!
    );
    fireEvent.change(input, { target: { value: "everything" } });
    expect(screen.getAllByTestId("context-file-item")).toHaveLength(2);
    expect(screen.getByTestId("chat-attachment-chip-pasted")).toBeTruthy();
    expect(screen.getByTestId("context-link-item")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-chip-pin")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![1]).toHaveLength(5);
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByTestId("chat-composer-attachments")).toBeNull();
    expect(screen.queryAllByTestId("context-file-item")).toHaveLength(0);
    expect(screen.queryByTestId("chat-attachment-chip-pasted")).toBeNull();
    expect(screen.queryByTestId("context-link-item")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-chip-pin")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-chip-placeholder")).toBeNull();
    expect(screen.queryByTestId("chat-composer-error")).toBeNull();
    // The image's object URL went with its chip.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("refuses unsupported file types with an explanation, and no retry hint", () => {
    const { input } = renderComposer();
    pasteFiles(input, [new File(["x"], "tool.exe")]);
    expect(screen.queryByTestId("context-file-item")).toBeNull();
    const error = screen.getByTestId("chat-composer-error");
    expect(error.textContent).toContain("Unsupported file type: tool.exe");
    expect(error.textContent).toContain("Choose a supported file type");
    // Nothing to retry: the composer is blank and Enter would do nothing.
    expect(error.textContent).not.toContain("try again");
    expect(error.getAttribute("data-retryable")).toBeNull();
  });

  it("explains the attachment cap without a retry hint", () => {
    const { input } = renderComposer();
    for (let i = 0; i < 21; i += 1) {
      pasteText(input, `https://example.com/${i}`);
    }
    expect(screen.getAllByTestId("context-link-item")).toHaveLength(20);
    const error = screen.getByTestId("chat-composer-error");
    expect(error.textContent).toBe("Up to 20 attachments per message.");
    expect(error.getAttribute("data-retryable")).toBeNull();
  });

  it("keeps the chip strip bounded at the attachment cap so the field and Send stay reachable", () => {
    const { input } = renderComposer();
    pasteFiles(
      input,
      Array.from(
        { length: 20 },
        (_, i) => new File(["x"], `note-${i}.txt`, { type: "text/plain" })
      )
    );
    expect(screen.getAllByTestId("context-file-item")).toHaveLength(20);
    const strip = screen.getByTestId("chat-composer-attachments");
    // jsdom does no layout: the cap is the class pair that scrolls the
    // chips inside a fixed height instead of growing the composer.
    expect(strip.className).toMatch(/\bmax-h-\S+/);
    expect(strip.className).toContain("overflow-y-auto");
    // The input row sits after the strip, outside it, so the cap can never
    // hide the field or the Send button.
    const send = screen.getByTestId("chat-composer-send");
    expect(strip.contains(input)).toBe(false);
    expect(strip.contains(send)).toBe(false);
    expect(
      strip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      strip.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("turns a lone pasted URL into a link chip and leaves prose alone", () => {
    const { input } = renderComposer();
    expect(pasteText(input, "https://example.com/report")).toBe(false);
    const chip = screen.getByTestId("context-link-item");
    expect(chip.getAttribute("title")).toBe("https://example.com/report");
    expect(input.value).toBe("");

    // Prose with a link in it is not intercepted.
    expect(pasteText(input, "see https://example.com please")).toBe(true);
    expect(screen.getAllByTestId("context-link-item")).toHaveLength(1);
  });

  it("offers a long paste as pasted.txt and can put it back inline", () => {
    const { input } = renderComposer();
    fireEvent.change(input, { target: { value: "Context: " } });
    input.setSelectionRange(9, 9);
    const long = Array(100).fill("line").join("\n");
    expect(pasteText(input, long)).toBe(false);

    const chip = screen.getByTestId("chat-attachment-chip-pasted");
    expect(chip.textContent).toContain("pasted.txt");
    expect(chip.textContent).toContain("100 lines");
    expect(input.value).toBe("Context: ");

    fireEvent.click(screen.getByTestId("chat-attachment-keep-inline"));
    expect(screen.queryByTestId("chat-attachment-chip-pasted")).toBeNull();
    expect(input.value).toBe(`Context: ${long}`);
  });

  it("removes a chip from its × button", () => {
    const { input } = renderComposer();
    pasteFiles(input, [new File(["a"], "a.txt", { type: "text/plain" })]);
    pasteText(input, "https://example.com");
    expect(screen.getByTestId("context-file-item")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove a.txt"));
    expect(screen.queryByTestId("context-file-item")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remove https://example.com"));
    expect(screen.queryByTestId("context-link-item")).toBeNull();
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("attaches a pin from the picker, skipping pins without ids and shortcuts", async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId("chat-composer-pin-button"));
    const options = await screen.findAllByTestId("chat-composer-pin-option");
    expect(options.map((o) => o.getAttribute("data-pin-id"))).toEqual([
      "pin-1",
      "pin-2",
    ]);
    fireEvent.click(options[0]!);
    const chip = screen.getByTestId("chat-attachment-chip-pin");
    expect(chip.textContent).toContain("Dev URL");
    expect(chip.textContent).toContain("http://localhost:5173");
  });

  it("uploads files on send and sends every attachment kind", async () => {
    const { onSend, uploadFile, input } = renderComposer();
    pasteFiles(input, [new File(["png"], "shot.png", { type: "image/png" })]);
    pasteText(input, "https://example.com/x");
    fireEvent.click(screen.getByTestId("chat-composer-pin-button"));
    fireEvent.click(
      (await screen.findAllByTestId("chat-composer-pin-option"))[1]!
    );
    fireEvent.change(input, { target: { value: "look at these" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0]![0].name).toBe("shot.png");
    expect(onSend).toHaveBeenCalledWith("look at these", [
      { type: "file", mediaId: "shot.png".length },
      { type: "link", url: "https://example.com/x" },
      { type: "pin", pinId: "pin-2" },
    ]);
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByTestId("chat-composer-attachments")).toBeNull();
  });

  it("sends an attachment with no text at all", async () => {
    const { onSend, input } = renderComposer();
    pasteText(input, "https://example.com/only");
    fireEvent.click(screen.getByTestId("chat-composer-send"));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("", [
        { type: "link", url: "https://example.com/only" },
      ])
    );
  });

  it("holds the Send button while an upload is in flight", async () => {
    let resolveUpload!: (value: { id: number }) => void;
    const uploadFile = vi.fn(
      () =>
        new Promise<{ id: number }>((resolve) => {
          resolveUpload = resolve;
        })
    );
    const { onSend, input } = renderComposer({ uploadFile });
    pasteFiles(input, [new File(["a"], "a.txt", { type: "text/plain" })]);
    fireEvent.change(input, { target: { value: "hold" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByTestId("chat-composer-uploading").textContent).toBe(
      "Uploading a.txt…"
    );
    expect(
      screen.getByTestId("context-file-item").getAttribute("data-status")
    ).toBe("uploading");
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpload({ id: 7 });
    });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("hold", [
        { type: "file", mediaId: 7 },
      ])
    );
  });

  it("keeps the draft and the chips when an upload fails, and retries only what failed", async () => {
    const uploadFile = vi
      .fn<(file: File) => Promise<{ id: number }>>()
      .mockImplementation(async (file) => {
        if (file.name === "bad.txt") throw new Error("disk full");
        return { id: 1 };
      });
    const { onSend, input } = renderComposer({ uploadFile });
    pasteFiles(input, [
      new File(["ok"], "ok.txt", { type: "text/plain" }),
      new File(["bad"], "bad.txt", { type: "text/plain" }),
    ]);
    fireEvent.change(input, { target: { value: "keep me" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("chat-composer-error").textContent).toContain(
        "Couldn't upload bad.txt: disk full"
      )
    );
    // The draft is intact, so this one offers a retry.
    expect(screen.getByTestId("chat-composer-error").textContent).toContain(
      "press Enter to try again"
    );
    expect(
      screen.getByTestId("chat-composer-error").getAttribute("data-retryable")
    ).toBe("true");
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("keep me");
    const chips = screen.getAllByTestId("context-file-item");
    expect(chips).toHaveLength(2);
    expect(chips[1]!.getAttribute("data-status")).toBe("failed");

    // Second attempt: ok.txt keeps its media id, only bad.txt uploads again.
    uploadFile.mockImplementation(async () => ({ id: 2 }));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(onSend).toHaveBeenCalledWith("keep me", [
      { type: "file", mediaId: 1 },
      { type: "file", mediaId: 2 },
    ]);
  });

  it("highlights the composer while files are dragged over it", () => {
    renderComposer();
    const form = screen.getByTestId("chat-composer");
    fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], files: [] } });
    expect(form.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(form, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["a"], "drop.md", { type: "text/markdown" })],
      },
    });
    expect(form.getAttribute("data-dragging")).toBeNull();
    expect(
      screen.getByTestId("context-file-item").getAttribute("data-file-name")
    ).toBe("drop.md");
  });

  it("disables the attach buttons with the composer", () => {
    renderComposer({ disabledReason: "The agent is not running." });
    expect(
      (screen.getByTestId("chat-composer-attach-button") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("chat-composer-pin-button") as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
