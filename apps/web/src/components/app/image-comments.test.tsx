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
import { api, ApiError } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
const mockApi = vi.mocked(api);
let sequence = 0;
beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = vi.fn();
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

async function open(
  provided?: FileItem,
  Component = ImageComments,
  onShared?: (location: import("./image-comments").ImageShareLocation) => void
) {
  const file: FileItem = provided ?? {
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
        <Component
          file={file}
          src={file.url}
          caption="Shot"
          positionLabel="1/1"
          onClose={vi.fn()}
          onShared={onShared}
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
  return { draft, file, unmount: view.unmount };
}

it.each(["upload", "post"])(
  "collects two notes and shares exactly one frozen batch during %s",
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
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await draft("Second note");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    // Collecting notes has no upload or delivery side effects.
    expect(uploads).toBe(0);
    expect(mockApi.mock.calls.some(([url]) => url.endsWith("/blocks"))).toBe(
      false
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Share with agent (2)" })
    );
    await screen.findByRole("button", { name: "Sharing…" });
    const first = screen.getByRole("button", {
      name: "Comment 1, draft",
    }) as HTMLButtonElement;
    expect(first.disabled).toBe(true);
    fireEvent.click(first);
    expect(screen.queryByPlaceholderText("Add a note…")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Sharing…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sharing…" }));
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
    expect(body.text).toContain("First note");
    expect(body.text).toContain("Second note");
    expect(body.attachments).toHaveLength(2);
    expect(uploads).toBe(2);
    await screen.findByRole("button", { name: "Comment 1, sent" });
    const metadataBody = mockApi.mock.calls.filter(([url]) =>
      url.endsWith("/files")
    )[1][1]!.body as FormData;
    const metadataFile = metadataBody.get("file") as File;
    const json = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(metadataFile);
    });
    const data = JSON.parse(json);
    expect(data.schema).toBe("dispatch.image-feedback.v2");
    expect(data.shareId).toBe(body.id);
    expect(data.annotations.map((c: { note: string }) => c.note)).toEqual([
      "First note",
      "Second note",
    ]);
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

it("does not let a closing note steal focus from the next note", async () => {
  mockApi.mockResolvedValue({ agents: [{ id: "agent-a", name: "Agent A" }] });
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const { draft } = await open();
  await draft("First inline note");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await draft("Next inline note");
  act(() => {
    frames.splice(0).forEach((callback) => callback(1));
  });
  const field = screen.getByPlaceholderText(
    "Add a note…"
  ) as HTMLTextAreaElement;
  expect(field.value).toBe("Next inline note");
  expect(document.activeElement).toBe(field);
});

it("aborts an invalidated cross-tab upload before posting, then keeps retry identity", async () => {
  let release!: (value: unknown) => void;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let uploads = 0,
    posts = 0;
  mockApi.mockImplementation(async (url) => {
    if (url === "/api/v1/agents")
      return { agents: [{ id: "agent-a", name: "Agent A" }] };
    if (url.endsWith("/files"))
      return ++uploads === 1 ? held : { file: { id: uploads + 20 } };
    if (url.endsWith("/blocks") && ++posts === 1)
      throw new Error("Response lost");
    return { delivered: false };
  });
  const { draft, file } = await open();
  await draft("Original");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await waitFor(() => expect(uploads).toBe(1));
  const key = `dispatch:image-comment-share:${file.url}:${file.updatedAt}`;
  act(() => {
    localStorage.setItem(key, "null");
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: "null" })
    );
  });
  await act(async () => {
    release({ file: { id: 20 } });
  });
  await screen.findByRole("alert");
  expect(posts).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Response lost")
  );
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await screen.findByRole("button", { name: "Comment 1, sent" });
  const bodies = mockApi.mock.calls
    .filter(([url]) => url.endsWith("/blocks"))
    .map(([, init]) => JSON.parse(init!.body as string));
  expect(bodies).toHaveLength(2);
  expect(bodies[1].id).toBe(bodies[0].id);
  expect(bodies[1].attachments).toEqual(bodies[0].attachments);
});

it("unlocks notes after a definitive rejected post and reuploads for a new target", async () => {
  let uploads = 0;
  mockApi.mockImplementation(async (url) => {
    if (url === "/api/v1/agents")
      return {
        agents: [
          { id: "agent-a", name: "Agent A" },
          { id: "agent-b", name: "Agent B" },
        ],
      };
    if (url.endsWith("/files")) return { file: { id: ++uploads + 30 } };
    if (url.includes("agent-a/blocks"))
      throw new ApiError(404, "Recipient disappeared");
    return { delivered: false };
  });
  const { draft } = await open();
  await draft("Keep this note");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await screen.findByRole("alert");
  const target = screen.getByRole("combobox", {
    name: "Agent",
  }) as HTMLSelectElement;
  expect(target.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Comment 1, draft" }));
  expect(
    (screen.getByPlaceholderText("Add a note…") as HTMLTextAreaElement).disabled
  ).toBe(false);
  expect(
    (screen.getByRole("button", { name: "Delete draft" }) as HTMLButtonElement)
      .disabled
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.keyDown(target, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "Agent B" }));
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await screen.findByRole("button", { name: "Comment 1, sent" });
  expect(uploads).toBe(4);
  const bodies = mockApi.mock.calls
    .filter(([url]) => url.endsWith("/blocks"))
    .map(([, init]) => JSON.parse(init!.body as string));
  expect(bodies[1].to).toBe("agent-b");
  expect(bodies[1].attachments[0].fileId).not.toBe(
    bodies[0].attachments[0].fileId
  );
});

it("recovers a potentially posted identity after another tab clears the pointer and reload", async () => {
  let rejectPost!: (reason: Error) => void;
  const heldPost = new Promise((_resolve, reject) => {
    rejectPost = reject;
  });
  let posts = 0,
    uploads = 0;
  mockApi.mockImplementation(async (url) => {
    if (url === "/api/v1/agents")
      return { agents: [{ id: "agent-a", name: "Agent A" }] };
    if (url.endsWith("/files")) return { file: { id: ++uploads + 50 } };
    if (url.endsWith("/blocks") && ++posts === 1) return heldPost;
    return { delivered: false };
  });
  const first = await open();
  await first.draft("Durable retry identity");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await waitFor(() => expect(posts).toBe(1));
  const key = `dispatch:image-comment-share:${first.file.url}:${first.file.updatedAt}`;
  act(() => {
    localStorage.setItem(key, "null");
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: "null" })
    );
  });
  await act(async () => {
    rejectPost(new Error("Response lost"));
  });
  await screen.findByRole("alert");
  first.unmount();
  // A real page reload recreates the atom families, not just their Provider.
  vi.resetModules();
  const { ImageComments: ReloadedComments } = await import("./image-comments");
  await open(first.file, ReloadedComments);
  await screen.findByRole("button", { name: "Comment 1, draft" });
  expect(
    (screen.getByRole("combobox", { name: "Agent" }) as HTMLSelectElement)
      .disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await screen.findByRole("button", { name: "Comment 1, sent" });
  const bodies = mockApi.mock.calls
    .filter(([url]) => url.endsWith("/blocks"))
    .map(([, init]) => JSON.parse(init!.body as string));
  expect(bodies).toHaveLength(2);
  expect(bodies[1].id).toBe(bodies[0].id);
  expect(bodies[1].attachments).toEqual(bodies[0].attachments);
  expect(uploads).toBe(2);
  expect(
    localStorage.getItem(
      `dispatch:image-comment-post:${first.file.url}:${first.file.updatedAt}:${bodies[0].id}`
    )
  ).toBe("null");
});

it("hands the stored stream and block location back after sharing", async () => {
  mockApi.mockImplementation(async (url, init) => {
    if (url === "/api/v1/agents")
      return { agents: [{ id: "agent-a", name: "Agent A" }] };
    if (url.endsWith("/files")) return { file: { id: 80 } };
    const body = JSON.parse(init!.body as string);
    return {
      delivered: false,
      block: {
        id: body.id,
        streamId: "stored-parent",
        threadId: "stored-thread",
      },
    };
  });
  const shared = vi.fn();
  const { draft } = await open(undefined, ImageComments, shared);
  await draft("Show where this message was stored.");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Share with agent (1)" }));
  await waitFor(() => expect(shared).toHaveBeenCalledTimes(1));
  const post = mockApi.mock.calls.find(([url]) => url.endsWith("/blocks"))!;
  const body = JSON.parse(post[1]!.body as string);
  expect(shared).toHaveBeenCalledWith({
    streamId: "stored-parent",
    threadId: "stored-thread",
    blockId: body.id,
  });
});

it("defaults to the actively viewed agent ahead of the source owner", async () => {
  window.history.replaceState({}, "", "/agents/active-agent/files");
  try {
    mockApi.mockResolvedValue({
      agents: [
        { id: "agent-a", name: "Source owner" },
        { id: "active-agent", name: "Actively viewed agent" },
      ],
    });
    const { draft } = await open();
    await draft("Keep the active conversation as recipient.");
    expect(
      (await screen.findByRole("combobox", { name: "Agent" })).textContent
    ).toContain("Actively viewed agent");
  } finally {
    window.history.replaceState({}, "", "/");
  }
});
