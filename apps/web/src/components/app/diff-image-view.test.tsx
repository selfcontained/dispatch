// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIFF_IMAGE_MAX_BYTES } from "@dispatch/shared";
import {
  diffImageCompareModeAtom,
  diffIncludeUncommittedAtom,
} from "@/lib/store";

import { DiffImageView } from "./diff-image-view";

function renderView(
  props: Partial<React.ComponentProps<typeof DiffImageView>> = {},
  store = createStore()
) {
  return {
    store,
    ...render(
      <Provider store={store}>
        <DiffImageView
          agentId="agt_1"
          filePath="assets/logo.png"
          status="modified"
          image={{ oldSize: 1000, newSize: 2000 }}
          {...props}
        />
      </Provider>
    ),
  };
}

/**
 * jsdom never decodes images, so naturalWidth/Height stay 0 and the load event
 * never fires on its own. Stamp the intrinsic size on and dispatch it by hand,
 * which is what the aspect-ratio gate reads.
 */
function loadImage(img: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(img, "naturalWidth", { value: width, writable: true });
  Object.defineProperty(img, "naturalHeight", {
    value: height,
    writable: true,
  });
  fireEvent.load(img);
}

function loadBothSides(
  container: HTMLElement,
  oldSize: [number, number],
  newSize: [number, number]
): void {
  const imgs = [...container.querySelectorAll("img")];
  loadImage(imgs[0]!, ...oldSize);
  loadImage(imgs[1]!, ...newSize);
}

describe("DiffImageView", () => {
  // Radix's Slider measures its thumb through ResizeObserver, which jsdom
  // does not implement.
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows both sides of a modified image with the diff's uncommitted scope", () => {
    const store = createStore();
    store.set(diffIncludeUncommittedAtom, false);
    const { container } = renderView({}, store);

    const srcs = [...container.querySelectorAll("img")].map((i) =>
      i.getAttribute("src")
    );
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).toContain("side=old");
    expect(srcs[1]).toContain("side=new");
    for (const src of srcs) {
      expect(src).toContain("path=assets%2Flogo.png");
      expect(src).toContain("includeUncommitted=false");
    }
  });

  it("requests the pre-rename path for the old side of a rename", () => {
    const { container } = renderView({
      status: "renamed",
      oldPath: "assets/old-logo.png",
    });
    const old = container.querySelector("img")!;
    expect(old.getAttribute("src")).toContain("path=assets%2Fold-logo.png");
  });

  it("renders only the new side for an added image, with no mode switcher", () => {
    const { container, queryByRole, getByText } = renderView({
      status: "added",
      image: { oldSize: null, newSize: 2048 },
    });
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toContain("side=new");
    expect(getByText("Added")).toBeTruthy();
    expect(queryByRole("group", { name: "Image comparison mode" })).toBeNull();
  });

  it("renders only the old side for a deleted image", () => {
    const { container, getByText } = renderView({
      status: "deleted",
      image: { oldSize: 4096, newSize: null },
    });
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toContain("side=old");
    expect(getByText("Deleted")).toBeTruthy();
  });

  it("replaces an over-limit side with a note instead of requesting it", () => {
    const { container, getByText } = renderView({
      status: "added",
      image: { oldSize: null, newSize: DIFF_IMAGE_MAX_BYTES + 1 },
    });
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(getByText(/Too large to preview/)).toBeTruthy();
  });

  it("switches to the stacked overlay and persists the chosen mode", () => {
    const { store, getByTestId, container } = renderView();
    loadBothSides(container, [200, 100], [400, 200]);

    fireEvent.click(getByTestId("diff-image-mode:swipe"));
    const overlay = getByTestId("diff-image-overlay");
    const overlayImgs = [...overlay.querySelectorAll("img")];
    expect(overlayImgs).toHaveLength(2);
    expect(overlayImgs[1]!.style.clipPath).toBe("inset(0 0 0 50%)");
    expect(store.get(diffImageCompareModeAtom)).toBe("swipe");

    fireEvent.click(getByTestId("diff-image-mode:onion"));
    const onionImgs = [
      ...getByTestId("diff-image-overlay").querySelectorAll("img"),
    ];
    expect(onionImgs[1]!.style.opacity).toBe("0.5");
    expect(onionImgs[1]!.style.clipPath).toBe("");
  });

  it("locks the overlay modes when the image was resized", () => {
    const store = createStore();
    store.set(diffImageCompareModeAtom, "swipe");
    const { container, getByTestId, getByText, queryByTestId } = renderView(
      {},
      store
    );
    loadBothSides(container, [200, 100], [200, 300]);

    expect(queryByTestId("diff-image-overlay")).toBeNull();
    expect(
      getByTestId("diff-image-mode:two-up").getAttribute("aria-pressed")
    ).toBe("true");
    for (const mode of ["swipe", "onion"]) {
      expect(
        getByTestId(`diff-image-mode:${mode}`).hasAttribute("disabled")
      ).toBe(true);
    }
    expect(getByText(/Image was resized/)).toBeTruthy();
  });

  it("falls back to 2-up and explains when one side cannot be previewed", () => {
    const store = createStore();
    store.set(diffImageCompareModeAtom, "onion");
    const { container, getByTestId, getByText, queryByTestId } = renderView(
      { image: { oldSize: DIFF_IMAGE_MAX_BYTES + 1, newSize: 2000 } },
      store
    );

    expect(queryByTestId("diff-image-overlay")).toBeNull();
    expect(getByText(/Too large to preview/)).toBeTruthy();
    expect(getByText(/One side cannot be previewed/)).toBeTruthy();
    expect(getByTestId("diff-image-mode:onion").hasAttribute("disabled")).toBe(
      true
    );
    // The renderable side is still shown rather than being hidden with it.
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("drops back to 2-up when a side fails to load mid-comparison", () => {
    const store = createStore();
    store.set(diffImageCompareModeAtom, "swipe");
    const { container, getByTestId, getByText, queryByTestId } = renderView(
      {},
      store
    );
    loadBothSides(container, [200, 100], [200, 100]);
    expect(getByTestId("diff-image-overlay")).toBeTruthy();

    const overlayImgs = [
      ...getByTestId("diff-image-overlay").querySelectorAll("img"),
    ];
    fireEvent.error(overlayImgs[1]!);

    expect(queryByTestId("diff-image-overlay")).toBeNull();
    expect(getByText("Preview unavailable")).toBeTruthy();
  });

  it("renders nothing requestable when there is no agent", () => {
    const { container } = renderView({
      agentId: null,
      status: "added",
      image: { oldSize: null, newSize: 10 },
    });
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});
