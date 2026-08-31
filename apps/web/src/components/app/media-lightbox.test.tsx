// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaLightbox } from "@/components/app/media-lightbox";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function item(name: string, updatedAt: string) {
  // A fresh object every call, like the memoized-but-recomputed lightboxItems
  // array in use-media.ts produces on every mediaFiles refetch — including
  // ones that change nothing.
  return {
    src: `/media/${name}?t=${updatedAt}`,
    caption: "",
    file: { name, size: 100, updatedAt },
  };
}

describe("MediaLightbox 'Updated' chip", () => {
  it("stays visible for its full duration despite unrelated re-renders, then clears", () => {
    vi.useFakeTimers();
    const setLightboxIndex = vi.fn();

    const { rerender } = render(
      <MediaLightbox
        item={item("a.png", "t1")}
        currentIndex={0}
        totalItems={1}
        setLightboxIndex={setLightboxIndex}
      />
    );
    expect(screen.queryByText("Updated")).toBeNull();

    // A real update: same file, new updatedAt.
    act(() => {
      rerender(
        <MediaLightbox
          item={item("a.png", "t2")}
          currentIndex={0}
          totalItems={1}
          setLightboxIndex={setLightboxIndex}
        />
      );
    });
    expect(screen.getByText("Updated")).toBeTruthy();

    // An unrelated re-render 1s later: same file, same updatedAt, but a
    // brand-new item object (as a no-op mediaFiles refetch would produce).
    // This must not orphan the chip's timer and leave it stuck forever.
    act(() => {
      vi.advanceTimersByTime(1000);
      rerender(
        <MediaLightbox
          item={item("a.png", "t2")}
          currentIndex={0}
          totalItems={1}
          setLightboxIndex={setLightboxIndex}
        />
      );
    });
    expect(screen.getByText("Updated")).toBeTruthy();

    // Past the flash duration (2200ms from when it was scheduled, ~1200ms
    // more from here): it must actually clear, not latch on permanently.
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(screen.queryByText("Updated")).toBeNull();
  });

  it("clears immediately on navigating to a different file, not carrying over stale text", () => {
    vi.useFakeTimers();
    const setLightboxIndex = vi.fn();

    const { rerender } = render(
      <MediaLightbox
        item={item("a.png", "t1")}
        currentIndex={0}
        totalItems={2}
        setLightboxIndex={setLightboxIndex}
      />
    );
    act(() => {
      rerender(
        <MediaLightbox
          item={item("a.png", "t2")}
          currentIndex={0}
          totalItems={2}
          setLightboxIndex={setLightboxIndex}
        />
      );
    });
    expect(screen.getByText("Updated")).toBeTruthy();

    // Navigate to a different file before the flash would naturally expire.
    act(() => {
      rerender(
        <MediaLightbox
          item={item("b.png", "t1")}
          currentIndex={1}
          totalItems={2}
          setLightboxIndex={setLightboxIndex}
        />
      );
    });
    expect(screen.queryByText("Updated")).toBeNull();
    expect(screen.getByText("b.png")).toBeTruthy();
  });
});
