// @vitest-environment jsdom
vi.mock(
  "@/components/app/chat/composer-input",
  () => import("@/test-utils/composer-input")
);
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "@/components/app/chat/chat-composer";
import { api } from "@/lib/api";

const mockApi = vi.mocked(api);

beforeEach(() => {
  localStorage.clear();
  mockApi.mockReset();
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn((file: File) => `blob:${file.name}`),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1000
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    500
  );
  HTMLImageElement.prototype.decode = vi.fn(async () => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["annotated"], { type: "image/png" }))
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderComposer() {
  const onSend = vi.fn(
    async (_text: string, _attachments: unknown[]) => undefined
  );
  let nextId = 100;
  const uploads: File[] = [];
  const uploadFile = vi.fn(async (file: File) => {
    uploads.push(file);
    return { id: nextId++, url: `/files/${file.name}` };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ChatComposer
        agentId={null}
        onSend={onSend}
        uploadFile={uploadFile}
        disabledReason={null}
      />
    </QueryClientProvider>
  );
  const input = screen.getByTestId(
    "chat-composer-input"
  ) as HTMLTextAreaElement;
  return { onSend, uploadFile, uploads, input };
}

function pasteFiles(target: HTMLElement, files: File[]) {
  fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: () => "",
    },
  });
}

function chip(name: string): HTMLElement {
  return screen
    .getAllByTestId("context-file-item")
    .find((el) => el.getAttribute("data-file-name") === name)!;
}

/** Opens the image's editor and adds one centered note per entry. */
async function markUp(name: string, notes: string[]) {
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`^Mark up ${name}`) })
  );
  const lightbox = await screen.findByTestId("file-lightbox");
  fireEvent.load(lightbox.querySelector("img")!);
  const surface = screen.getByLabelText(
    "Image callouts. Press Enter to add a centered note."
  );
  for (const note of notes) {
    fireEvent.keyDown(surface, { key: "Enter" });
    fireEvent.change(await screen.findByPlaceholderText("Add a note…"), {
      target: { value: note },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Add a note…")).toBeNull()
    );
  }
  return lightbox;
}

const shot = () => new File(["a"], "shot.png", { type: "image/png" });
const other = () => new File(["bb"], "other.png", { type: "image/png" });

describe("ChatComposer image markup", () => {
  it("saves callouts onto the attachment with Done, sending nothing", async () => {
    const { input, onSend, uploadFile } = renderComposer();
    pasteFiles(input, [shot()]);
    within(chip("shot.png")).getByTestId("context-file-markup-hint");
    await markUp("shot.png", ["Too much padding", "Wrong color"]);
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(screen.queryByTestId("file-lightbox")).toBeNull()
    );
    expect(
      within(chip("shot.png")).getByTestId("context-file-note-count")
        .textContent
    ).toBe("2");
    expect(
      within(chip("shot.png")).queryByTestId("context-file-markup-hint")
    ).toBeNull();
    screen.getByRole("button", { name: "Mark up shot.png, 2 notes" });
    expect(onSend).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(mockApi).not.toHaveBeenCalled();
    expect(
      Object.keys(localStorage).filter((key) => key.includes("image-comment"))
    ).toEqual([]);
  });

  it("reopens with the saved notes, and Cancel keeps them unchanged", async () => {
    const { input } = renderComposer();
    pasteFiles(input, [shot()]);
    await markUp("shot.png", ["Too much padding"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByTestId("file-lightbox")).toBeNull()
    );

    const lightbox = await markUp("shot.png", ["Discard me"]);
    fireEvent.click(
      within(lightbox).getByRole("button", { name: "Comment 1, draft" })
    );
    const field = (await screen.findByPlaceholderText(
      "Add a note…"
    )) as HTMLTextAreaElement;
    expect(field.value).toBe("Too much padding");
    fireEvent.click(
      within(field.parentElement!).getByRole("button", { name: "Cancel" })
    );
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Add a note…")).toBeNull()
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByTestId("file-lightbox")).toBeNull()
    );
    expect(
      within(chip("shot.png")).getByTestId("context-file-note-count")
        .textContent
    ).toBe("1");
    screen.getByRole("button", { name: "Mark up shot.png, 1 note" });
  });

  it("drops the markup when its attachment is removed", async () => {
    const { input } = renderComposer();
    pasteFiles(input, [shot()]);
    await markUp("shot.png", ["Too much padding"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByTestId("file-lightbox")).toBeNull()
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    pasteFiles(input, [shot()]);
    expect(
      within(chip("shot.png")).queryByTestId("context-file-note-count")
    ).toBeNull();
  });

  it("posts each marked-up image in the share-flow shape and leaves plain images alone", async () => {
    const { input, onSend, uploads } = renderComposer();
    pasteFiles(input, [shot(), other()]);
    await markUp("shot.png", ["Too much @padding"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByTestId("file-lightbox")).toBeNull()
    );
    fireEvent.change(input, { target: { value: "please fix @agent" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(uploads.map((file) => file.name)).toEqual([
      "shot.png",
      expect.stringMatching(/^feedback-.+\.png$/),
      expect.stringMatching(/^feedback-.+\.json$/),
      "other.png",
    ]);
    const [text, attachments] = onSend.mock.calls[0]!;
    // Typed mentions still route; notes and names are literal, as in the share flow.
    expect(text).toBe(
      "please fix @agent\n\n1. Too much @​padding\n\nFeedback on shot.png"
    );
    expect(attachments).toEqual([
      { type: "file", fileId: 101, caption: "Feedback on shot.png" },
      { type: "file", fileId: 102, caption: "Image and callout details" },
      { type: "file", fileId: 103 },
    ]);
    const metadata = JSON.parse(await uploads[2]!.text());
    expect(metadata).toMatchObject({
      schema: "dispatch.image-feedback.v2",
      original: {
        fileId: 100,
        name: "shot.png",
        url: "/files/shot.png",
        width: 1000,
        height: 500,
      },
      derivedFileId: 101,
      derivedSize: { width: 1000, height: 500 },
      annotations: [
        {
          number: 1,
          note: "Too much @padding",
          region: {
            x: 0.5,
            y: 0.5,
            width: 0,
            height: 0,
            units: "normalized",
            origin: "top-left",
          },
        },
      ],
    });
    expect(metadata.shareId).toBe(
      uploads[1]!.name.replace(/^feedback-|\.png$/g, "")
    );
  });

  it("retries only the failed markup step, keeping the original's details", async () => {
    const { input, onSend, uploads, uploadFile } = renderComposer();
    const succeed = uploadFile.getMockImplementation()!;
    let failedOnce = false;
    uploadFile.mockImplementation(async (file: File) => {
      if (file.name.endsWith(".json") && !failedOnce) {
        failedOnce = true;
        throw new Error("network");
      }
      return succeed(file);
    });
    pasteFiles(input, [shot()]);
    await markUp("shot.png", ["Too much padding"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByTestId("file-lightbox")).toBeNull()
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText(/Couldn't upload markup for shot.png/);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // Original and copy uploaded once; only the record is uploaded again.
    expect(uploads.map((file) => file.name.split(/-[0-9a-f-]{36}/)[0])).toEqual(
      ["shot.png", "feedback", "feedback"]
    );
    const metadata = JSON.parse(await uploads[2]!.text());
    expect(metadata.original).toMatchObject({
      fileId: 100,
      url: "/files/shot.png",
    });
    expect(metadata.derivedFileId).toBe(101);
    expect(onSend.mock.calls[0]![1]).toEqual([
      { type: "file", fileId: 101, caption: "Feedback on shot.png" },
      { type: "file", fileId: 102, caption: "Image and callout details" },
    ]);
  });

  it("counts a marked-up image's extra attachment against the cap", async () => {
    const { input } = renderComposer();
    pasteFiles(
      input,
      Array.from(
        { length: 20 },
        (_, i) =>
          new File(["x".repeat(i + 1)], `s${i}.png`, { type: "image/png" })
      )
    );
    expect(screen.queryByText(/Remove 1 attachment to send/)).toBeNull();
    await markUp("s0.png", ["Note"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(/Remove 1 attachment to send/)).toBeTruthy();
  });
});
