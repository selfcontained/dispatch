// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "jotai";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageComments } from "./image-comments";
import type { FileItem } from "./types";
import { api } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
const mockApi = vi.mocked(api);
let sequence = 0;
beforeEach(() => {
  mockApi.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["png"], { type: "image/png" }))
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open() {
  const file: FileItem = {
    id: 7,
    ownerAgentId: "agent-a",
    name: "shot.png",
    url: `/image-${++sequence}.png`,
    updatedAt: "2026-11-10",
    size: 42,
    mimeType: "image/png",
    media: "image",
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <Provider>
      <QueryClientProvider client={client}>
        <ImageComments
          file={file}
          src={file.url}
          caption="Shot"
          positionLabel="1/1"
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    </Provider>
  );
  const img = view.container.ownerDocument.querySelector('img[alt="Shot"]')!;
  Object.defineProperties(img, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 650 },
  });
  fireEvent.load(img);
  const surface = screen.getByLabelText(
    "Image callouts. Press Enter to add a centered note."
  );
  const draft = async (text: string) => {
    fireEvent.keyDown(surface, { key: "Enter" });
    const field = await screen.findByPlaceholderText("Add a note…");
    fireEvent.change(field, { target: { value: text } });
  };
  return { draft };
}

it.each(["upload", "post"])(
  "keeps the sending draft frozen when other bubbles are clicked during %s",
  async (heldStage) => {
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let uploads = 0;
    mockApi.mockImplementation(async (url) => {
      if (url === "/api/v1/agents")
        return { agents: [{ id: "agent-a", name: "Agent A" }] };
      if (url.endsWith("/files")) {
        uploads++;
        if (heldStage === "upload" && uploads === 1) return held;
        return { file: { id: uploads + 10 } };
      }
      if (url.endsWith("/blocks")) {
        if (heldStage === "post") return held;
        return { delivered: false };
      }
      throw new Error(`Unexpected ${url}`);
    });
    const { draft } = await open();
    await draft("First note");
    await draft("Second note");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("Add a note…") as HTMLTextAreaElement)
          .disabled
      ).toBe(true)
    );
    const first = screen.getByRole("button", {
      name: "Comment 1, draft",
    }) as HTMLButtonElement;
    expect(first.disabled).toBe(true);
    fireEvent.click(first);
    expect(
      (screen.getByPlaceholderText("Add a note…") as HTMLTextAreaElement).value
    ).toBe("Second note");
    expect(
      (screen.getByPlaceholderText("Add a note…") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await act(async () => {
      release(
        heldStage === "upload" ? { file: { id: 11 } } : { delivered: false }
      );
    });
    await screen.findByRole("button", { name: "Comment 2, sent" });
    const posts = mockApi.mock.calls.filter(([url]) => url.endsWith("/blocks"));
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1]!.body as string);
    expect(body.to).toBe("agent-a");
    expect(body.text).toContain("Second note");
  }
);

it("returns focus to the same bubble after keyboard dismissal", async () => {
  mockApi.mockResolvedValue({ agents: [{ id: "agent-a", name: "Agent A" }] });
  const { draft } = await open();
  await draft("Keyboard note");
  fireEvent.keyDown(screen.getByPlaceholderText("Add a note…"), {
    key: "Escape",
  });
  const bubble = screen.getByRole("button", { name: "Comment 1, draft" });
  await waitFor(() => expect(document.activeElement).toBe(bubble));
});
