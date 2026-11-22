// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageComments, type ImageComposeMarkup } from "./image-comments";
import type { FileItem } from "./types";
import { api } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

// The image is 1000x650 and the stage SVG maps client pixels to image pixels
// one to one, so anything right of x=1000 or below y=650 (inside the 1200x800
// stage) is backdrop.
const IMAGE = { x: 500, y: 300 };
const BACKDROP = { x: 1100, y: 300 };
let sequence = 0;
beforeEach(() => {
  vi.mocked(api).mockResolvedValue({ agents: [] });
  localStorage.setItem("dispatch:markup-hint-dismissed", "true");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = vi.fn();
  const proto = window.SVGElement.prototype as unknown as Record<
    string,
    unknown
  >;
  proto.createSVGPoint = () => ({
    x: 0,
    y: 0,
    matrixTransform(this: { x: number; y: number }) {
      return { x: this.x, y: this.y };
    },
  });
  proto.getScreenCTM = () => ({ inverse: () => ({}) });
  vi.spyOn(
    window.SVGElement.prototype,
    "getBoundingClientRect"
  ).mockReturnValue({
    left: 0,
    top: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem("dispatch:markup-hint-dismissed");
});

function renderViewer(compose?: ImageComposeMarkup) {
  const onClose = vi.fn();
  const file: FileItem = {
    id: 7,
    ownerAgentId: "agent-a",
    name: "shot.png",
    url: `/backdrop-${++sequence}.png`,
    updatedAt: "2026-11-16",
    size: 42,
    mimeType: "image/png",
    media: "image",
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <Provider store={createStore()}>
      <QueryClientProvider client={client}>
        {compose ? (
          <ImageComments
            compose={compose}
            src={file.url}
            caption="Shot"
            positionLabel=""
            onClose={onClose}
          />
        ) : (
          <ImageComments
            file={file}
            src={file.url}
            caption="Shot"
            positionLabel="1/1"
            onClose={onClose}
          />
        )}
      </QueryClientProvider>
    </Provider>
  );
  const img = document.querySelector('img[alt="Shot"]')!;
  Object.defineProperties(img, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 650 },
  });
  fireEvent.load(img);
  const stage = () =>
    document.querySelector<SVGSVGElement>(
      '[data-testid="image-viewer-stage"] > svg'
    )!;
  const press = (
    down: { x: number; y: number },
    up: { x: number; y: number } = down
  ) => {
    const target = stage();
    fireEvent.pointerDown(target, {
      pointerId: 1,
      button: 0,
      clientX: down.x,
      clientY: down.y,
    });
    if (up !== down)
      fireEvent.pointerMove(target, {
        pointerId: 1,
        clientX: up.x,
        clientY: up.y,
      });
    fireEvent.pointerUp(target, {
      pointerId: 1,
      button: 0,
      clientX: up.x,
      clientY: up.y,
    });
    // The click that follows a press; with pointer capture it targets the stage.
    fireEvent.click(target, { clientX: up.x, clientY: up.y });
  };
  return { onClose, press };
}

it("closes on a click or tap on the backdrop around the image", () => {
  const { onClose, press } = renderViewer();
  press(BACKDROP);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("stays open for clicks on the image or a toolbar", () => {
  const { onClose, press } = renderViewer();
  press(IMAGE);
  const header = screen.getByTestId("image-viewer-header");
  fireEvent.pointerDown(header, { pointerId: 1, button: 0 });
  fireEvent.pointerUp(header, { pointerId: 1, button: 0 });
  fireEvent.click(header);
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(onClose).not.toHaveBeenCalled();
});

it("stays open when a pan or drag ends on the backdrop", () => {
  const { onClose, press } = renderViewer();
  press(IMAGE, BACKDROP);
  press(BACKDROP, { x: BACKDROP.x + 40, y: BACKDROP.y + 200 });
  // Released over the header (outside the stage), after a backdrop press.
  press(BACKDROP, { x: BACKDROP.x, y: -20 });
  expect(onClose).not.toHaveBeenCalled();
});

it("still adds a callout from a markup click on the image, and a callout click stays open", async () => {
  const { onClose, press } = renderViewer();
  fireEvent.click(screen.getByRole("button", { name: "Markup" }));
  press(IMAGE);
  const field = await screen.findByPlaceholderText("Add a note…");
  fireEvent.change(field, { target: { value: "Fix this" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Comment 1, draft" }));
  expect(await screen.findByDisplayValue("Fix this")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

it("dismisses an open note editor on the first backdrop click and closes on the second", async () => {
  const { onClose, press } = renderViewer();
  fireEvent.click(screen.getByRole("button", { name: "Markup" }));
  press(IMAGE);
  expect(await screen.findByPlaceholderText("Add a note…")).toBeTruthy();
  press(BACKDROP);
  expect(screen.queryByPlaceholderText("Add a note…")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  press(BACKDROP);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps Escape closing the viewer", () => {
  const { onClose } = renderViewer();
  fireEvent.keyDown(screen.getByTestId("file-lightbox"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("hands saved notes back when the compose-mode viewer closes from the backdrop", async () => {
  const onDone = vi.fn();
  const { onClose, press } = renderViewer({
    fileName: "paste.png",
    callouts: [],
    onDone,
  });
  press(IMAGE);
  fireEvent.change(await screen.findByPlaceholderText("Add a note…"), {
    target: { value: "Composer note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  press(BACKDROP);
  expect(onDone).toHaveBeenCalledWith([
    expect.objectContaining({ number: 1, note: "Composer note" }),
  ]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("pads its toolbars by the safe-area insets so the image stage is the free area", () => {
  renderViewer();
  expect(screen.getByTestId("image-viewer-header").className).toContain(
    "pt-safe"
  );
  expect(screen.getByTestId("image-viewer-footer").className).toContain(
    "pb-safe-2"
  );
});
