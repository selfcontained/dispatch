// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type FileItem } from "@/components/app/types";

import { FileCardList } from "./file-item-card";

afterEach(cleanup);

const image = (name: string): FileItem => ({
  id: name.length,
  name,
  size: 2048,
  updatedAt: "2026-11-13T00:00:00.000Z",
  url: `/api/v1/agents/a1/files/${name}`,
  seen: true,
  source: "screenshot",
  mimeType: "image/png",
  media: "image",
  description: name,
});

function renderList(active: boolean) {
  return render(
    <FileCardList
      files={[image("one.png"), image("two.png")]}
      animatingFileKeys={new Set()}
      openLightbox={() => {}}
      active={active}
    />
  );
}

describe("FileCardList", () => {
  it("renders no image src while the Files tab is inactive", () => {
    renderList(false);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.getAttribute("src")).toBeNull();
      expect(img.getAttribute("srcset")).toBeNull();
    }
  });

  it("loads lazily once active and keeps the src after the tab hides", () => {
    const { rerender } = renderList(true);
    const img = screen.getByAltText("one.png");
    const original =
      "/api/v1/agents/a1/files/one.png?t=2026-11-13T00%3A00%3A00.000Z";
    // Display-sized copies, never the original, for the preview.
    expect(img.getAttribute("src")).toBe(`${original}&w=640`);
    expect(img.getAttribute("srcset")).toBe(
      `${original}&w=320 320w, ${original}&w=640 640w, ${original}&w=1280 1280w`
    );
    expect(img.getAttribute("sizes")).toContain("auto");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");

    rerender(
      <FileCardList
        files={[image("one.png"), image("two.png")]}
        animatingFileKeys={new Set()}
        openLightbox={() => {}}
        active={false}
      />
    );
    expect(screen.getByAltText("one.png").getAttribute("src")).not.toBeNull();
  });
});
