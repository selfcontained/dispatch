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
  CHAT_DRAFT_MAX_BYTES,
  type ChatComposerDraft,
  EMPTY_CHAT_DRAFT,
} from "@/lib/chat-draft";
import { CHAT_DRAFT_STORAGE_PREFIX, chatDraftAtomFamily } from "@/lib/store";

const pins: AgentPin[] = [
  {
    id: "pin-1",
    label: "Dev URL",
    value: "http://localhost:5173",
    type: "url",
  },
];

const usedAgentIds = new Set<string>();

afterEach(() => {
  cleanup();
  // The family caches an atom's first read, so every test gets its own
  // agent id and drops the atom afterwards.
  for (const id of usedAgentIds) chatDraftAtomFamily.remove(id);
  usedAgentIds.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
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

function storageKey(agentId: string): string {
  return `${CHAT_DRAFT_STORAGE_PREFIX}${agentId}`;
}

function seed(agentId: string, draft: Partial<ChatComposerDraft>): void {
  usedAgentIds.add(agentId);
  window.localStorage.setItem(
    storageKey(agentId),
    JSON.stringify({ ...EMPTY_CHAT_DRAFT, ...draft })
  );
}

function stored(agentId: string): ChatComposerDraft {
  return JSON.parse(
    window.localStorage.getItem(storageKey(agentId)) ?? "null"
  ) as ChatComposerDraft;
}

function renderComposer(
  agentId: string,
  props: Partial<Parameters<typeof ChatComposer>[0]> = {}
) {
  usedAgentIds.add(agentId);
  const onSend = vi.fn(
    async (_text: string, _attachments: unknown[]) => undefined
  );
  const uploadFile = vi.fn(async (file: File) => ({ id: file.name.length }));
  const view = render(
    <ChatComposer
      agentId={agentId}
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
  return { ...view, onSend, uploadFile, input };
}

function pasteText(target: HTMLElement, text: string): boolean {
  return fireEvent.paste(target, {
    clipboardData: { items: [], getData: () => text },
  });
}

function pasteFiles(target: HTMLElement, files: File[]): boolean {
  return fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: () => "",
    },
  });
}

function sendButton(): HTMLButtonElement {
  return screen.getByTestId("chat-composer-send") as HTMLButtonElement;
}

describe("ChatComposer draft persistence", () => {
  it("persists the text, links and pins as they are added", () => {
    const { input } = renderComposer("agt_persist");
    fireEvent.change(input, { target: { value: "half a thought" } });
    expect(stored("agt_persist").text).toBe("half a thought");

    pasteText(input, "https://example.com/spec");
    expect(stored("agt_persist").links).toEqual(["https://example.com/spec"]);

    fireEvent.click(screen.getByTestId("chat-composer-pin-button"));
    fireEvent.click(screen.getByTestId("chat-composer-pin-option"));
    expect(stored("agt_persist").pinIds).toEqual(["pin-1"]);
  });

  it("restores the text, link and pin chips on mount", () => {
    seed("agt_restore", {
      text: "still here",
      links: ["https://example.com/a"],
      pinIds: ["pin-1", "pin-gone"],
    });
    const { input } = renderComposer("agt_restore");
    expect(input.value).toBe("still here");
    expect(screen.getByTestId("context-link-item").getAttribute("title")).toBe(
      "https://example.com/a"
    );
    // A pin the agent no longer has is not shown and not sent.
    expect(screen.getAllByTestId("chat-attachment-chip-pin")).toHaveLength(1);
    expect(sendButton().disabled).toBe(false);
  });

  it("keeps drafts apart per agent", () => {
    seed("agt_one", { text: "for one" });
    seed("agt_two", { text: "for two" });
    const first = renderComposer("agt_one");
    expect(first.input.value).toBe("for one");
    first.unmount();
    const second = renderComposer("agt_two");
    expect(second.input.value).toBe("for two");
  });

  it("brings a pasted-text chip back whole, with its undo", () => {
    const long = Array(90).fill("line").join("\n");
    seed("agt_pasted", {
      files: [
        {
          name: "pasted.txt",
          size: long.length,
          mime: "text/plain",
          pasted: long,
        },
      ],
    });
    const { input } = renderComposer("agt_pasted");
    const chip = screen.getByTestId("chat-attachment-chip-pasted");
    expect(chip.textContent).toContain("pasted.txt");
    expect(chip.textContent).toContain("90 lines");
    expect(sendButton().disabled).toBe(false);

    fireEvent.click(screen.getByTestId("chat-attachment-keep-inline"));
    expect(input.value).toBe(long);
    expect(screen.queryByTestId("chat-attachment-chip-pasted")).toBeNull();
    expect(stored("agt_pasted").files).toEqual([]);
    expect(stored("agt_pasted").text).toBe(long);
  });

  it("restores a picked file as a placeholder that holds the send until removed", () => {
    seed("agt_file", {
      text: "see attached",
      files: [{ name: "shot.png", size: 1234, mime: "image/png" }],
    });
    renderComposer("agt_file");
    const chip = screen.getByTestId("chat-attachment-chip-placeholder");
    expect(chip.textContent).toContain("shot.png");
    expect(chip.textContent).toContain("Needs re-attaching");
    expect(sendButton().disabled).toBe(true);
    expect(
      screen.getByTestId("chat-composer-reattach-hint").textContent
    ).toContain("shot.png");
    // Still persisted while it sits there.
    expect(stored("agt_file").files).toEqual([
      { name: "shot.png", size: 1234, mime: "image/png" },
    ]);

    fireEvent.click(screen.getByLabelText("Remove shot.png"));
    expect(screen.queryByTestId("chat-attachment-chip-placeholder")).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(stored("agt_file").files).toEqual([]);
  });

  it("marks a paste whose body was dropped for size as needing another paste", () => {
    seed("agt_dropped", {
      files: [
        { name: "pasted.txt", size: 99_999, mime: "text/plain", pasted: null },
      ],
    });
    renderComposer("agt_dropped");
    const chip = screen.getByTestId("chat-attachment-chip-placeholder");
    expect(chip.textContent).toContain("Too large to keep");
    expect(sendButton().disabled).toBe(true);
  });

  it("caps the stored draft by dropping the pasted body, keeping the live chip", () => {
    const huge = "x".repeat(CHAT_DRAFT_MAX_BYTES + 10);
    const { input } = renderComposer("agt_cap");
    fireEvent.change(input, { target: { value: "note" } });
    pasteText(input, huge);
    // In this session the chip is real and sendable...
    expect(screen.getByTestId("chat-attachment-chip-pasted")).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
    // ...but what hit storage fits the cap, with the body dropped.
    const draft = stored("agt_cap");
    expect(draft.text).toBe("note");
    expect(draft.files).toEqual([
      {
        name: "pasted.txt",
        size: huge.length,
        mime: "text/plain",
        pasted: null,
      },
    ]);
    expect(
      window.localStorage.getItem(storageKey("agt_cap"))!.length
    ).toBeLessThanOrEqual(CHAT_DRAFT_MAX_BYTES);
  });

  it("remembers a picked file's name only", () => {
    const { input } = renderComposer("agt_pick");
    pasteFiles(input, [new File(["png"], "shot.png", { type: "image/png" })]);
    expect(stored("agt_pick").files).toEqual([
      { name: "shot.png", size: 3, mime: "image/png" },
    ]);
    fireEvent.click(screen.getByLabelText("Remove shot.png"));
    expect(stored("agt_pick").files).toEqual([]);
  });

  it("clears what was sent and keeps what was typed meanwhile", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        })
    );
    seed("agt_clear", {
      text: "ship it",
      links: ["https://example.com/pr"],
      pinIds: ["pin-1"],
    });
    const { input } = renderComposer("agt_clear", { onSend });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("ship it", [
      { type: "link", url: "https://example.com/pr" },
      { type: "pin", pinId: "pin-1" },
    ]);

    fireEvent.change(input, { target: { value: "next thought" } });
    await act(async () => {
      resolve();
    });
    await waitFor(() => expect(input.value).toBe("next thought"));
    expect(stored("agt_clear")).toEqual({
      ...EMPTY_CHAT_DRAFT,
      text: "next thought",
    });
    expect(screen.queryByTestId("context-link-item")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-chip-pin")).toBeNull();
  });

  it("keeps the draft on a failed send", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("no terminal")));
    seed("agt_fail", { text: "important", links: ["https://example.com"] });
    const { input } = renderComposer("agt_fail", { onSend });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("chat-composer-error")).toBeTruthy()
    );
    expect(input.value).toBe("important");
    expect(stored("agt_fail").text).toBe("important");
    expect(stored("agt_fail").links).toEqual(["https://example.com"]);
  });

  it("reads a corrupt stored value as an empty draft", () => {
    usedAgentIds.add("agt_corrupt");
    window.localStorage.setItem(storageKey("agt_corrupt"), '{"text": 5}');
    const { input } = renderComposer("agt_corrupt");
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "fresh" } });
    expect(stored("agt_corrupt")).toEqual({
      ...EMPTY_CHAT_DRAFT,
      text: "fresh",
    });
  });
});
